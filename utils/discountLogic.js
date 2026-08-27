/**
 * Pure discount math shared by the React client and the Node server.
 * Kept in .js (not .ts) so services/*.js can import it directly.
 */

export function calculateJobDiscount(originalPrice, pageCount, rules) {
  if (!rules || rules.length === 0) {
    return { rule: null, originalAmount: originalPrice, discountAmount: 0, finalAmount: originalPrice, savingsPercentage: 0 };
  }

  const applicableRules = rules.filter((rule) => {
    if (!rule.is_active) return false;
    if (rule.condition_type === "pages") return pageCount >= rule.threshold;
    if (rule.condition_type === "amount") return originalPrice >= rule.threshold;
    return false;
  });

  if (applicableRules.length === 0) {
    return { rule: null, originalAmount: originalPrice, discountAmount: 0, finalAmount: originalPrice, savingsPercentage: 0 };
  }

  const scored = applicableRules.map((rule) => {
    let amount = 0;
    if (rule.discount_type === "percent") {
      amount = (originalPrice * rule.discount_value) / 100;
      if (rule.max_discount_cap !== null && rule.max_discount_cap !== undefined) {
        amount = Math.min(amount, rule.max_discount_cap);
      }
    } else {
      amount = Math.min(rule.discount_value, originalPrice);
    }
    return { rule, amount };
  });

  scored.sort((a, b) => {
    if (b.rule.priority !== a.rule.priority) return b.rule.priority - a.rule.priority;
    return b.amount - a.amount;
  });

  const bestRule = scored[0].rule;
  const discountAmount = scored[0].amount;
  const finalAmount = Math.max(0, originalPrice - discountAmount);
  const savingsPercentage = originalPrice > 0 ? (discountAmount / originalPrice) * 100 : 0;

  return {
    rule: bestRule,
    originalAmount: originalPrice,
    discountAmount,
    finalAmount,
    savingsPercentage: Math.round(savingsPercentage * 100) / 100,
  };
}
