/**
 * Simple input sanitization utility to prevent basic XSS and injection
 */
export const sanitizeInput = (input: string): string => {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[<>]/g, '') // Remove < and >
    .trim();
};

/**
 * Validates BDT Amount
 */
export const isValidAmount = (amount: number): boolean => {
  return !isNaN(amount) && amount > 0 && amount <= 500000;
};
