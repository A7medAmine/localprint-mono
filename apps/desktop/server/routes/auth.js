// Operator login, logout, password change and forgotten-password recovery.
import { getSettings, setInternalState } from "../../db.js";
import {
  consumeEmailCode,
  generateRecoveryCode,
  recoveryCodeStatus,
  recoveryOptions,
  sendEmailResetCode,
  verifyEmailCode,
  verifyRecoveryCode,
} from "../passwordRecovery.js";
import {
  checkAdminPassword,
  hashPassword,
  isFreshInstall,
  passwordPolicyError,
} from "../passwords.js";
import {
  clearLoginFailures,
  generateToken,
  loginGuard,
  recordLoginFailure,
  refreshMustChangePassword,
  requireAdmin,
  revokeOtherTokens,
  revokeToken,
  setMustChangePassword,
} from "../adminAuth.js";

export function registerAuthRoutes(app) {
  // First-run status. On a fresh install there is no credential yet, so asking
  // for one is pure friction — the UI sends the operator straight to the setup
  // wizard instead (which is where the password actually gets set).
  app.get("/api/auth/status", (req, res) => {
    res.status(200).json({ freshInstall: isFreshInstall() });
  });

  // Issue a session token without a password — only while the install is still
  // fresh. Such a token is already useless for anything but the password change
  // and logout, because requireAdmin blocks the rest while the credential is
  // the factory default.
  app.post("/api/auth/bootstrap", (req, res) => {
    if (!isFreshInstall()) {
      return res.status(403).json({ success: false, error: "Setup already completed" });
    }
    refreshMustChangePassword();
    const token = generateToken();
    res.status(200).json({ success: true, token });
  });

  // Verify admin password — returns a session token on success
  app.post("/api/auth/verify", loginGuard, (req, res) => {
    const { password } = req.body;
    const ok = checkAdminPassword(password);

    if (!ok) {
      recordLoginFailure(req);
      return res.status(200).json({ success: false });
    }

    clearLoginFailures(req);
    const mustChangePassword = refreshMustChangePassword();
    const token = generateToken();
    res.status(200).json({ success: true, token, mustChangePassword });
  });

  // Logout — invalidate the caller's token
  app.post("/api/auth/logout", (req, res) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
      revokeToken(auth.slice(7));
    }
    res.status(200).json({ success: true });
  });

  // Logout everywhere else — kill every token except the caller's
  app.post("/api/auth/logout-all", requireAdmin, (req, res) => {
    revokeOtherTokens(req.adminToken);
    res.status(200).json({ success: true });
  });

  // ── Forgotten password ──────────────────────────────────────────────────
  // Which recovery routes this install can offer. Public: the login screen
  // needs it before anyone is signed in, and it only says yes/no plus a
  // masked address.
  app.get("/api/auth/recovery-options", (req, res) => {
    try {
      res.status(200).json(recoveryOptions());
    } catch (err) {
      console.error("❌ Recovery options error:", err);
      res.status(200).json({ recoveryCode: false, email: null });
    }
  });

  // Mail a 6-digit reset code to the connected Gmail account (never to an
  // address from the request). Behind the login lockout like any guessable
  // credential path.
  app.post("/api/auth/forgot/send-email", loginGuard, async (req, res) => {
    try {
      const { sendEmail } = await import("../../services/gmailService.js");
      const result = await sendEmailResetCode(sendEmail, { shopName: getSettings().shopName || "" });
      if (!result.ok) {
        if (result.retryMs) res.set("Retry-After", String(Math.ceil(result.retryMs / 1000)));
        return res.status(result.status).json({ success: false, error: result.error, retryMs: result.retryMs });
      }
      res.status(200).json({ success: true, sentTo: result.sentTo });
    } catch (err) {
      console.error("❌ Reset email error:", err);
      res.status(502).json({ success: false, error: "Could not send the email. Check the Gmail connection." });
    }
  });

  // Set a new password with a recovery code or an emailed code. On success
  // every old session dies, the caller is signed in, and — when the recovery
  // code was spent — a replacement code is handed back to be saved.
  app.post("/api/auth/forgot/reset", loginGuard, (req, res) => {
    try {
      const { method, code, newPassword } = req.body || {};
      if (method !== "recovery" && method !== "email") {
        return res.status(400).json({ success: false, error: "Unknown recovery method" });
      }
      const policyError = passwordPolicyError(newPassword);
      if (policyError) {
        return res.status(400).json({ success: false, error: policyError });
      }
      const valid = method === "recovery" ? verifyRecoveryCode(code) : verifyEmailCode(code);
      if (!valid) {
        recordLoginFailure(req);
        return res.status(400).json({
          success: false,
          error: method === "recovery" ? "Invalid recovery code" : "Invalid or expired code",
        });
      }

      clearLoginFailures(req);
      setInternalState("adminPassword", hashPassword(newPassword));
      setMustChangePassword(false);
      if (method === "email") consumeEmailCode();
      const newRecoveryCode = method === "recovery" ? generateRecoveryCode() : undefined;

      revokeOtherTokens(null);
      const token = generateToken();
      console.log(`🔑 Admin password reset via ${method === "recovery" ? "recovery code" : "email code"}; all sessions invalidated`);
      res.status(200).json({ success: true, token, newRecoveryCode });
    } catch (err) {
      console.error("❌ Password reset error:", err);
      res.status(500).json({ success: false, error: "Failed to reset password" });
    }
  });

  app.get("/api/auth/recovery-code", requireAdmin, (req, res) => {
    res.status(200).json(recoveryCodeStatus());
  });

  // (Re)generate the recovery code. Asks for the current password again so an
  // unattended, still-signed-in screen can't be used to mint a back door.
  app.post("/api/auth/recovery-code", requireAdmin, (req, res) => {
    try {
      if (!checkAdminPassword(req.body?.currentPassword)) {
        return res.status(400).json({ success: false, error: "Current password is incorrect" });
      }
      const code = generateRecoveryCode();
      res.status(200).json({ success: true, code, ...recoveryCodeStatus() });
    } catch (err) {
      console.error("❌ Recovery code error:", err);
      res.status(500).json({ success: false, error: "Failed to create a recovery code" });
    }
  });

  // Change admin password
  app.post("/api/settings/password", requireAdmin, (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;

      if (!checkAdminPassword(currentPassword)) {
        return res.status(400).json({ success: false, error: "Current password is incorrect" });
      }
      const policyError = passwordPolicyError(newPassword);
      if (policyError) {
        return res.status(400).json({ success: false, error: policyError });
      }
      setInternalState("adminPassword", hashPassword(newPassword));
      setMustChangePassword(false);

      // Invalidate every other session — a password change should log out
      // anything that might have been using the old one.
      revokeOtherTokens(req.adminToken);

      console.log("🔑 Admin password updated (hashed); other sessions invalidated");
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("❌ Password change error:", err);
      res.status(500).json({ success: false, error: "Failed to change password" });
    }
  });
}
