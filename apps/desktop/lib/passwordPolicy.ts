// Client mirror of server/passwords.js passwordPolicyError, so a form can say
// what's wrong before the round trip. The server still has the final word.
export const DEFAULT_PASSWORD = "admin123";

export function passwordPolicyMessage(pw: string, confirm: string, isRtl: boolean): string | null {
  const tr = (ar: string, en: string) => (isRtl ? ar : en);
  if (pw.length < 8) return tr("يجب أن تكون كلمة المرور 8 أحرف على الأقل.", "Password must be at least 8 characters.");
  if (/^\d+$/.test(pw)) return tr("لا يمكن أن تتكون كلمة المرور من أرقام فقط.", "Password cannot be all digits.");
  if (pw === DEFAULT_PASSWORD) return tr("اختر كلمة مرور مختلفة عن الافتراضية.", "Choose a password different from the default.");
  if (pw !== confirm) return tr("كلمتا المرور غير متطابقتين.", "Passwords do not match.");
  return null;
}

/** Server error strings are English; translate the ones the operator can hit. */
export function translateAuthError(message: string, isRtl: boolean): string {
  if (!isRtl) return message;
  const map: Record<string, string> = {
    "Current password is incorrect": "كلمة المرور الحالية غير صحيحة.",
    "Password must be at least 8 characters": "يجب أن تكون كلمة المرور 8 أحرف على الأقل.",
    "Password cannot be all digits": "لا يمكن أن تتكون كلمة المرور من أرقام فقط.",
    "Choose a password other than the default": "اختر كلمة مرور مختلفة عن الافتراضية.",
    "Invalid recovery code": "مفتاح الاسترداد غير صحيح.",
    "Too many failed attempts. Try again later.": "محاولات فاشلة كثيرة. حاول لاحقًا.",
  };
  return map[message] ?? message;
}
