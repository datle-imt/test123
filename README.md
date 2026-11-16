# Customer Portal Enrollment performance + passkey login

This extends the earlier Enrollment performance script. The web buttons are driven
by Playwright; a separate local Python process handles the native Windows Security
PIN screen. The YubiKey touch remains manual. No virtual authenticator is installed.

**Status:** JavaScript/Python syntax checks and offline logic tests have passed.
The real portal login, Windows native dialog, actual YubiKey, and live measurements
have NOT been executed in the authoring environment. Native automation is best-effort
and may be blocked by Windows policy or a different accessibility tree.

## Flow

1. Open `https://portal.yubico.com/login`.
2. Click `//a[text()='Login']` when shown.
3. Start the native helper, then click `//button[text()='Sign in with Passkey']`.
4. Wait for the English Windows Security PIN dialog for `login.yubico.com`.
5. Set the supplied PIN and invoke OK exactly once. Never retry a rejected PIN.
6. The operator touches the physical YubiKey when Windows requests it.
7. Confirm the authenticated portal's Enrollment Open button is visible.
8. Measure Open Enrollment, Next page, and email Search; export the CSV.

Login, PIN, and touch time are excluded from all three Enrollment measurements.
If the session is already authenticated, the login controls and PIN entry are skipped.

## Requirements and initial setup (PowerShell)

Use a local, unlocked Windows desktop, Node.js 20 or newer, Python 3, and the registered
test YubiKey. The script uses a headed browser. The provided native selectors target
the English dialog shown in the supplied screenshot.

Extract the ZIP and open PowerShell in the extracted `portal-enrollment-perf-passkey-v4` directory:

```powershell
npm install
npx playwright install chromium
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The JS file automatically uses `.venv\Scripts\python.exe` when present. There is no
need to activate the environment. To choose another installed interpreter, set
`$env:PYTHON_EXE` to its full executable path; do not include extra arguments.

## Configure FIDO2 PIN in .env (local only)

A blank `.env` is included in the project. Edit it locally and insert the PIN for
your registered **test** YubiKey (example only):

```dotenv
FIDO2_PIN=1234
```

Do not commit or share a filled `.env` file. The `.gitignore` excludes `.env`,
and `.env.example` is provided as a safe, unfilled template. The code uses `dotenv`
to parse only `FIDO2_PIN`; it **does not** put the PIN in the browser environment.
The PIN goes to the Python helper over its private stdin pipe. The operator still
touches the physical YubiKey when Windows requests it. No PIN is printed in logs.

## Run (Windows PowerShell)

```powershell
node .\enrollment-performance.js --fresh-login
```

Or use the PowerShell wrapper (reads the same `.env` through JavaScript):

```powershell
.\run.ps1 -FreshLogin
```

No PIN prompt or PowerShell environment-variable setup is necessary. If Windows Security native PIN automation is unavailable, the script now prints the failure and waits for you to enter the PIN manually (without a second automatic attempt). To skip the helper entirely, use manual PIN mode:

```powershell
node .\enrollment-performance.js --fresh-login --manual-pin
```

The script supports an existing `FIDO2_PIN` process environment variable as a
backward-compatible fallback if `.env` is missing/blank. The `.env` value takes
precedence. The loaded PIN is removed from the Node process environment before
launching the browser; avoid adding other secrets to this project.

## Maximized browser window

The script launches headed Chromium/Edge with `args: ['--start-maximized']` and
`viewport: null` in both fresh-login and persistent-session modes. This makes the
browser occupy the available desktop work area and makes the page viewport follow
that window. **Maximize is not F11 fullscreen** (Windows taskbar remains visible).
This is a native-window behavior: ensure your Windows desktop is unlocked, and use
a normal headed browser rather than a remote/headless session.

`--fresh-login` uses a temporary browser context instead of the saved portal profile.
It does not delete your normal browser profile or prevent OS/identity-provider SSO.
Without this flag the script reuses its dedicated `.portal-playwright-profile` directory.
Do not share or commit that directory: it may contain authenticated session data.

## Native PIN behavior and limitations

- The helper requires an accessible `Windows Security` window owned by
  `CredentialUIBroker.exe` under Windows System32 or SysWOW64. It verifies the RP text
  `login.yubico.com`, the security-key/PIN labels, and a unique password Edit control.
  A different native host, language, or accessibility structure is not guessed.
- It tries UI Automation ValuePattern first, then a focused numeric keyboard fallback
  only if that setter failed. The fallback verifies focus before each character.
  It invokes the unique OK button once; an uncertain result is never resubmitted.
- It never logs or reads back the PIN, uses the clipboard, dumps native controls,
  takes a desktop screenshot, or changes security policies.
- It reports a submission attempt, NOT authentication success. The JS script verifies
  the actual authenticated portal Home. The helper is stopped before timing starts.
- Other account/device choosers are not blindly clicked. If Windows asks you to choose
  Security key or an account first, make that choice manually; the helper waits up to
  90 seconds for the specific PIN screen. Overall login timeout is 5 minutes.
- Use one login run at a time. Close other Windows Security/passkey dialogs beforehand.
  Keep the workstation unlocked and do not switch focus while the PIN is being entered.
- Microsoft documents additional restrictions on automated input into authentication
  dialogs in Windows updates released on or after January 13, 2026. Ordinary UIA or
  injected input may fail or be ignored. Administrator elevation is only a temporary,
  controlled-test mitigation when explicitly approved; it is not a guaranteed fix.
  This script does not auto-elevate, alter UAC, or disable secure-desktop protections.
- If the PIN is rejected or input is blocked, stop and investigate; do not repeatedly
  re-run an uncertain PIN. Use manual mode to keep the performance test running:

```powershell
node .\enrollment-performance.js --fresh-login --manual-pin
```

Manual mode still clicks the two web buttons, but both PIN entry and YubiKey touch are
performed by the operator. Login time is still excluded from the measured results.

Optional controls:

```powershell
# Use an installed Microsoft Edge instead of downloaded Chromium.
$env:BROWSER_CHANNEL = 'msedge'

# Only attempt UIA ValuePattern, without the keyboard fallback.
$env:PIN_INPUT_METHOD = 'value'

# Explicit numeric keyboard method (still subject to Windows policy).
$env:PIN_INPUT_METHOD = 'keys'
```

Unset PIN_INPUT_METHOD or set it to `auto` to restore the default.

## Measurement definition

Each interval begins immediately before its Playwright interaction. It ends when the
expected request rows and pagination are observed and remain unchanged for 200 ms.
This is **UI/DOM readiness elapsed time**, including automation overhead and the quiet
period, not isolated API latency, paint-only duration, or a performance SLA assertion.

- Open: page-1 pagination and nonempty request rows.
- Next: the next pagination range and a changed first row.
- Search: page-1 pagination and every rendered row containing the requested email.
  An unchanged result total is allowed; the prior script's count-change prerequisite
  was removed because a valid filter can leave the total unchanged.

The table selectors/readiness conditions remain screenshot-derived heuristics, not
live-DOM-verified locators. A 200 ms quiet window does not prove that every subsequent
network/background update has finished. If the UI retains old matching rows while
searching, use an inspected table loading flag or its specific response signal to
strengthen readiness before using these numbers as an authoritative benchmark.
The scenarios require more than one unfiltered page and at least one email match.

Results are written to `enrollment-performance-results.csv` (overwritten per run).
The console says `[MEASURED]`, not performance PASS/FAIL, because no latency threshold
has been specified. Error page screenshots are only taken after authentication.

## Offline checks included

```powershell
node --check .\enrollment-performance.js
.\.venv\Scripts\python.exe -m py_compile .\windows-security-pin.py
node .\tests\test_login_flow.cjs
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
```

The tests use fake pages/native controls. They check the login sequence, reused-session
skip, direct passkey screen, popup handoff, origin/RP/process guards, one-submit behavior,
focus loss, and the table readiness predicate. They do not demonstrate successful real
Windows automation or actual portal performance. `run.ps1` has not been executed here.

## Primary documentation

Playwright web dialogs: `https://playwright.dev/docs/dialogs`

pywinauto UIA/desktop entry points:
`https://pywinauto.readthedocs.io/en/latest/getting_started.html`

Microsoft Windows authentication-input hardening notice:
`https://support.microsoft.com/en-us/servicing/os/windows/docs/2026/01/new-behavior-restricting-certain-applications-to-autofill-credentials-introduced-by-the-windows-janu`

Playwright authenticated browser-state handling: `https://playwright.dev/docs/auth`

## v4 change: explicit fallback and diagnostics

The .env PIN is used only by the Windows helper, never by Chromium. The helper
checks only the expected Windows Security security-key dialog. It reports
initialization and, after eight seconds, whether the protected PIN dialog
remains inaccessible. If it cannot start or it exits unsuccessfully **before
a confirmed PIN submission**, the browser remains open and the script asks
you to enter the PIN manually. The script still waits for Enrollment Home and
then runs the same three timing measurements. It does not bypass Windows
security hardening or repeatedly send PINs.

To avoid the login prompt on subsequent runs, omit `--fresh-login` once you
have manually authenticated in the default persistent browser profile:

```powershell
node .\enrollment-performance.js --manual-pin
# Future runs after the persistent profile has a valid session:
node .\enrollment-performance.js
```

`--fresh-login` intentionally starts a temporary context and cannot reuse
that saved session. Run without it if you want session reuse. If a saved login
expires, you must sign in again.

If you need to know why Windows automation fails, run without `--manual-pin`
and capture the `[LOGIN]` / `[LOGIN ERROR]` lines only, omitting passwords,
PINs, and session tokens. Offline checks do not prove the protected Windows
dialog is automatable on your machine.
