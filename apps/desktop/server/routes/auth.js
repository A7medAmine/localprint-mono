// Operator login, logout, password change and forgotten-password recovery.
import { setInternalState } from "../../db.js";
import {
  generateRecoveryCode,
  recoveryCodeStatus,
  recoveryOptions,
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
  // needs it before anyone is signed in, and it only says yes/no.
  app.get("/api/auth/recovery-options", (req, res) => {
    try {
      res.status(200).json(recoveryOptions());
    } catch (err) {
      console.error("❌ Recovery options error:", err);
      res.status(200).json({ recoveryCode: false });
    }
  });

  // Set a new password with the recovery code. On success every old session
  // dies, the caller is signed in, and the spent code is replaced by a new one
  // that is handed back to be saved.
  app.post("/api/auth/forgot/reset", loginGuard, (req, res) => {
    try {
      const { code, newPassword } = req.body || {};
      const policyError = passwordPolicyError(newPassword);
      if (policyError) {
        return res.status(400).json({ success: false, error: policyError });
      }
      if (!verifyRecoveryCode(code)) {
        recordLoginFailure(req);
        return res.status(400).json({ success: false, error: "Invalid recovery code" });
      }

      clearLoginFailures(req);
      setInternalState("adminPassword", hashPassword(newPassword));
      setMustChangePassword(false);
      const newRecoveryCode = generateRecoveryCode();

      revokeOtherTokens(null);
      const token = generateToken();
      console.log("🔑 Admin password reset via recovery code; all sessions invalidated");
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
