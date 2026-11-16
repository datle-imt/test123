"""Offline tests: fake controls only; does not exercise a real Windows dialog."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location(
    'pin_helper', Path(__file__).resolve().parents[1] / 'windows-security-pin.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Field:
    def __init__(self, raises=False):
        self.set_calls = []
        def set_value(value):
            self.set_calls.append(value)
            if raises:
                raise RuntimeError('blocked')
        self.iface_value = SimpleNamespace(SetValue=set_value)
    def set_focus(self):
        pass
    def has_keyboard_focus(self):
        return True


class Button:
    def __init__(self, raises=False):
        self.count = 0
        def invoke():
            self.count += 1
            if raises:
                raise RuntimeError('uncertain submit')
        self.iface_invoke = SimpleNamespace(Invoke=invoke)
    def window_text(self):
        return 'OK'
    def is_visible(self):
        return True
    def is_enabled(self):
        return True


class Dialog:
    handle = 77
    def __init__(self, button):
        self.button = button
    def descendants(self, **kwargs):
        return [self.button]
    def set_focus(self):
        pass


class Guards(unittest.TestCase):
    def test_expected_rp(self):
        self.assertTrue(module.rp_matches('Passkey for login.yubico.com', 'login.yubico.com'))
        self.assertFalse(module.rp_matches('login.yubico.com.evil.test', 'login.yubico.com'))
        self.assertFalse(module.rp_matches('evil-login.yubico.com', 'login.yubico.com'))
        self.assertFalse(module.rp_matches('example.com', 'login.yubico.com'))

    def test_broker_path(self):
        self.assertTrue(module.broker_path_allowed(r'C:\Windows\System32\CredentialUIBroker.exe', r'C:\Windows'))
        self.assertFalse(module.broker_path_allowed(r'C:\Temp\CredentialUIBroker.exe', r'C:\Windows'))
        self.assertFalse(module.broker_path_allowed(r'C:\Windows\System32\chrome.exe', r'C:\Windows'))

    def test_pin_error_detection(self):
        self.assertTrue(module.looks_like_pin_error('Incorrect PIN'))
        self.assertTrue(module.looks_like_pin_error('You have 3 attempts remaining'))
        self.assertFalse(module.looks_like_pin_error('Enter your security key PIN'))

    def test_value_pattern_submits_exactly_once(self):
        field, button = Field(), Button()
        keys = []
        module.enter_and_submit(Dialog(button), field, '8642', 'auto',
                                SimpleNamespace(send_keys=lambda *a, **k: keys.append(a)), lambda: 77)
        self.assertEqual(field.set_calls, ['8642'])
        self.assertEqual(button.count, 1)
        self.assertEqual(keys, [])

    def test_value_rejection_does_not_submit_in_value_mode(self):
        field, button = Field(raises=True), Button()
        with self.assertRaises(module.PinAutomationError):
            module.enter_and_submit(Dialog(button), field, '8642', 'value', None, lambda: 77)
        self.assertEqual(button.count, 0)

    def test_auto_fallback_still_submits_only_once(self):
        field, button, keys = Field(raises=True), Button(), []
        module.enter_and_submit(Dialog(button), field, '8642', 'auto',
                                SimpleNamespace(send_keys=lambda text, **kwargs: keys.append(text)), lambda: 77)
        self.assertEqual(keys, ['^a{BACKSPACE}', '8', '6', '4', '2'])
        self.assertEqual(button.count, 1)

    def test_focus_loss_prevents_input(self):
        field, button, keys = Field(), Button(), []
        with self.assertRaises(module.PinAutomationError):
            module.enter_and_submit(Dialog(button), field, '8642', 'keys',
                                    SimpleNamespace(send_keys=lambda text, **kwargs: keys.append(text)), lambda: 99)
        self.assertEqual(keys, [])
        self.assertEqual(button.count, 0)

    def test_uncertain_ok_never_triggers_second_submission(self):
        field, button, keys = Field(), Button(raises=True), []
        with self.assertRaises(RuntimeError):
            module.enter_and_submit(Dialog(button), field, '8642', 'auto',
                                    SimpleNamespace(send_keys=lambda text, **kwargs: keys.append(text)), lambda: 77)
        self.assertEqual(button.count, 1)
        self.assertEqual(keys, [])


if __name__ == '__main__':
    unittest.main()
