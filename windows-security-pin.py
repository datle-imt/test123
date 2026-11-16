"""Enter a supplied PIN ONCE in the expected Windows Security FIDO dialog.

Input: a JSON object {"pin": "..."} on stdin. Never put a PIN in arguments.
No screenshots, clipboard use, credential dumps, PIN logging, or automatic retry.
This is best-effort desktop automation, not a bypass of Windows security policy.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time


class PinAutomationError(RuntimeError):
    """An intentionally non-sensitive, user-readable diagnostic."""


def rp_matches(text: str, expected_rp: str) -> bool:
    pattern = r"(?<![\w.-])" + re.escape(expected_rp) + r"(?![\w.-])"
    return re.search(pattern, text, flags=re.IGNORECASE) is not None


def broker_path_allowed(executable: str, windows_directory: str) -> bool:
    # Use Windows path semantics even in the offline tests on a non-Windows host.
    import ntpath
    candidate = ntpath.normcase(ntpath.normpath(executable))
    return any(
        candidate == ntpath.normcase(ntpath.join(
            windows_directory, folder, "CredentialUIBroker.exe"
        ))
        for folder in ("System32", "SysWOW64")
    )


def looks_like_pin_error(text: str) -> bool:
    return bool(re.search(
        r"incorrect|wrong\s+pin|pin\s+(?:is\s+)?(?:not\s+correct|blocked)|"
        r"too\s+many\s+attempts|tries\s+remaining|attempts\s+remaining",
        text, flags=re.IGNORECASE,
    ))


def safe_text(dialog) -> str:
    # Read labels only, never the password field or any Edit value.
    return " ".join(
        item.window_text() for item in dialog.descendants(control_type="Text")
        if item.is_visible()
    )


def trusted_dialogs(desktop, psutil):
    for window in desktop.windows(title="Windows Security", visible_only=True):
        try:
            executable = psutil.Process(window.process_id()).exe()
        except (psutil.Error, OSError):
            continue
        if broker_path_allowed(executable, os.environ.get("SystemRoot", r"C:\Windows")):
            yield window


def choose_pin_edit(dialog):
    edits = []
    for item in dialog.descendants(control_type="Edit"):
        try:
            if (item.is_visible() and item.is_enabled()
                    and bool(item.element_info.element.CurrentIsPassword)):
                edits.append(item)
        except Exception:
            continue
    if len(edits) > 1:
        named = [item for item in edits if "pin" in item.window_text().casefold()]
        if len(named) == 1:
            return named[0]
        raise PinAutomationError("Multiple password fields found; refusing to guess.")
    return edits[0] if edits else None


def focus_guard(dialog, edit, foreground_window):
    if int(foreground_window() or 0) != int(dialog.handle) or not edit.has_keyboard_focus():
        raise PinAutomationError(
            "Focus is not on the verified security-key PIN field. No further input sent."
        )


def type_numeric_pin_once(dialog, edit, pin: str, keyboard, foreground_window):
    # Numeric-only keyboard fallback avoids interpreting a PIN as key syntax.
    if not pin.isascii() or not pin.isdigit():
        raise PinAutomationError(
            "Keyboard entry supports numeric PINs only. Use --pin-method value or manual mode."
        )
    dialog.set_focus()
    edit.set_focus()
    focus_guard(dialog, edit, foreground_window)
    keyboard.send_keys("^a{BACKSPACE}", pause=0.05)
    for character in pin:
        focus_guard(dialog, edit, foreground_window)
        keyboard.send_keys(character, pause=0.05, vk_packet=False)


def enter_and_submit(dialog, edit, pin, method, keyboard, foreground_window):
    if method in ("auto", "value"):
        try:
            # Direct ValuePattern call avoids pywinauto's set_edit_text action log,
            # which may include the text being set. Do NOT read the PIN back.
            edit.iface_value.SetValue(pin)
            used_method = "UI Automation ValuePattern"
        except Exception:
            if method == "value":
                raise PinAutomationError(
                    "Windows rejected ValuePattern PIN entry. No submit or retry was performed."
                ) from None
            print("[LOGIN] ValuePattern unavailable; trying focused numeric keyboard entry once.", flush=True)
            type_numeric_pin_once(dialog, edit, pin, keyboard, foreground_window)
            used_method = "focused keyboard input"
    else:
        type_numeric_pin_once(dialog, edit, pin, keyboard, foreground_window)
        used_method = "focused keyboard input"

    # Exactly ONE submission. Never press Enter after an uncertain OK invocation.
    buttons = [button for button in dialog.descendants(control_type="Button")
               if button.is_visible() and button.window_text().strip().casefold() == "ok"]
    if len(buttons) != 1:
        raise PinAutomationError(
            "A unique OK button was not found. PIN was not submitted; inspect the dialog manually."
        )
    deadline = time.monotonic() + 3.0
    while not buttons[0].is_enabled():
        if time.monotonic() >= deadline:
            raise PinAutomationError("OK stayed disabled; Windows may have rejected the PIN input.")
        time.sleep(0.1)
    print(f"[LOGIN] Sending OK using {used_method}. Touch your YubiKey when Windows requests it.", flush=True)
    buttons[0].iface_invoke.Invoke()
    print("[LOGIN] PIN submission attempted once; login success is verified in the browser.", flush=True)


def automate(args, pin: str) -> None:
    if sys.platform != "win32":
        raise PinAutomationError("The native PIN helper must run locally on Windows.")
    # Deferred imports allow compilation and pure guard tests on non-Windows hosts.
    try:
        import ctypes
        from ctypes import wintypes
        import psutil
        from pywinauto import Desktop, keyboard
    except ImportError:
        raise PinAutomationError(
            "Missing Windows dependencies. Install requirements.txt with the configured Python interpreter."
        ) from None

    logging.disable(logging.CRITICAL)
    foreground_window = ctypes.windll.user32.GetForegroundWindow
    foreground_window.restype = wintypes.HWND
    desktop = Desktop(backend="uia")
    print("HELPER_READY", flush=True)
    deadline = time.monotonic() + args.timeout
    saw_broker = False
    last_probe_failed = False
    probe_notice_sent = False
    while time.monotonic() < deadline:
        target = None
        try:
            for dialog in trusted_dialogs(desktop, psutil):
                saw_broker = True
                text = safe_text(dialog)
                if not rp_matches(text, args.rp):
                    continue
                if not re.search(r"security\s+key", text, re.IGNORECASE) or "pin" not in text.casefold():
                    continue
                if looks_like_pin_error(text):
                    raise PinAutomationError(
                        "The dialog already reports a PIN error/retry warning. No PIN submitted."
                    )
                edit = choose_pin_edit(dialog)
                if edit is not None:
                    if target is not None:
                        raise PinAutomationError("Multiple matching FIDO dialogs; refusing to guess.")
                    target = (dialog, edit)
        except PinAutomationError:
            raise
        except Exception:
            # A disappearing window is normal while Windows transitions screens.
            last_probe_failed = True
            time.sleep(0.2)
            continue
        if target is not None:
            # Do not catch failures here and re-enter the outer discovery loop.
            # Once input begins, this run will never attempt PIN submission again.
            dialog, edit = target
            print(f"[LOGIN] Verified security-key PIN dialog for {args.rp}.", flush=True)
            enter_and_submit(dialog, edit, pin, args.method, keyboard, foreground_window)
            # Observe the submitted dialog briefly for an immediate incorrect-PIN error.
            # Successful authentication still requires the portal Home check in JS.
            check_until = time.monotonic() + 2.0
            while time.monotonic() < check_until:
                try:
                    text = safe_text(dialog)
                except Exception:
                    return  # Dialog closed or changed after submission.
                if looks_like_pin_error(text):
                    raise PinAutomationError("PIN was rejected. Stopped after one submission; no retry.")
                time.sleep(0.15)
            return
        if not probe_notice_sent and time.monotonic() > deadline - args.timeout + 8.0:
            probe_notice_sent = True
            print("[LOGIN] PIN dialog not yet accessible to UI Automation; no PIN sent.", flush=True)
        time.sleep(0.2)
    hint = "Broker found, but the expected accessible PIN field was not found." if saw_broker else "No accessible, verified Windows Security broker dialog found."
    if last_probe_failed:
        hint += " Some UI Automation probes were unavailable."
    raise PinAutomationError(
        hint + " Windows hardening, a different account/device chooser, language, or UI layout may be involved. "
        "Use --manual-pin, or review approved local test-machine permissions."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--rp", default="login.yubico.com")
    parser.add_argument("--method", choices=("auto", "value", "keys"), default="auto")
    args = parser.parse_args()
    try:
        # UTF-8 bytes are used to avoid the Windows console code-page default.
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        pin = payload.get("pin")
        if not isinstance(pin, str) or not pin or any(ord(c) < 32 for c in pin):
            raise PinAutomationError("A nonempty PIN without control characters must be supplied on stdin.")
        if args.timeout <= 0:
            raise PinAutomationError("The native-dialog timeout must be positive.")
        automate(args, pin)
        return 0
    except PinAutomationError as error:
        print(f"[LOGIN ERROR] {error}", file=sys.stderr, flush=True)
        return 2
    except Exception as error:
        # Never print exception repr/arguments: a library exception could contain input.
        print(f"[LOGIN ERROR] Native automation failed ({type(error).__name__}). No automatic retry.",
              file=sys.stderr, flush=True)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
