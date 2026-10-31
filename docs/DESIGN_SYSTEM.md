# Design system (Bet420)

Tokens live in `public/css/design-tokens.css` (`--ds-*`), loaded from `views/partials/head.ejs`.
They are additive — existing variables (`--gold`, `--bg-card`, …) are untouched; migrate screens gradually.

## Rules
- Colors/spacing/radius come from `--ds-*` tokens, never new hex literals in views.
- Theme: dark by default; `prefers-color-scheme: light` or `<html data-theme="light|dark">` overrides.
- Touch targets ≥ 44px on coarse pointers (`--ds-tap`); focus ring is global (`:focus-visible`).
- Every async list needs 3 states: loading (`.ds-skeleton`), empty, error (`.ds-state--error`, `role="alert"`).
- No inline `style=` / inline handlers (CSP). Use classes + `data-*` hooks handled in `public/js/*`.
- All user-facing text via `t('key')` in `locales/bn.json` + `locales/en.json`; numbers via `toLocaleString`.
- Respect `prefers-reduced-motion` (handled globally).

## Migration order (suggested)
1. Home hero + game/sports cards + quick deposit
2. Profile / Security Center
3. Mobile bottom-nav + loading/empty/error states
4. Contrast audit (Lighthouse), image `loading="lazy"` + `width/height`, font `display=swap` (already set)
