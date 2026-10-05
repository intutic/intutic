/**
 * Intutic design tokens: the single source for the dashboard and the docs site.
 * build-tokens.ts turns them into dist/variables.css; apps/dashboard/DESIGN.md
 * explains the rules for using them.
 *
 * Colour roles exist once per theme. Light is the default (`:root`); dark
 * applies under `[data-theme='dark']` (the dashboard) or `.dark` (VitePress).
 * Every text role meets WCAG AA (4.5:1) on every surface role of its theme, and
 * `border-control` meets 3:1 for form controls (WCAG 1.4.11).
 */

/** The website's brand blue. Fill colour in both themes; text on light only. */
const BRAND_BLUE = '#196BA7';

export type ColorRoles = Record<string, string>;

export const colors: { light: ColorRoles; dark: ColorRoles } = {
  light: {
    // Surfaces, back to front
    'bg-primary': '#FBFCFD', // page canvas
    'bg-secondary': '#F4F6F8', // sidebar, toolbars, table headers
    'bg-tertiary': '#EDF0F3', // wells, tracks, inactive chips
    'bg-elevated': '#FFFFFF', // cards, menus, dialogs
    'bg-input': '#FFFFFF',
    'bg-hover': '#EDF0F3',
    'bg-active': '#E7F0F7', // selected row or nav item

    // Text
    'text-primary': '#0F1720',
    'text-secondary': '#4A5562',
    'text-tertiary': '#5C6774',
    'text-inverse': '#F7F9FB',
    'text-link': BRAND_BLUE,
    'text-on-accent': '#FFFFFF',

    // Borders
    border: '#E2E6EB',
    'border-subtle': '#EDF0F3',
    'border-hover': '#C9D0D8',
    'border-control': '#7A8695',
    'border-focus': BRAND_BLUE,

    // Accent
    accent: BRAND_BLUE,
    'accent-hover': '#155A8C',
    'accent-text': BRAND_BLUE,
    'accent-subtle': '#E7F0F7',
    'accent-muted': '#F1F6FA',

    // Status. The base colour is text-safe, so it serves icons, dots and labels.
    success: '#17733A',
    'success-text': '#17733A',
    'success-bg': '#E8F5EC',
    'success-border': '#B5DEC1',
    warning: '#8A5A00',
    'warning-text': '#8A5A00',
    'warning-bg': '#FEF4DA',
    'warning-border': '#EDD08A',
    error: '#B42B26',
    'error-text': '#B42B26',
    'error-bg': '#FCEBEA',
    'error-border': '#F2BDBA',
    'error-fill': '#B42B26', // danger button; text-on-accent sits on it
    'error-fill-hover': '#962220',
    'success-fill': '#17733A',
    'success-fill-hover': '#125F30',
    info: BRAND_BLUE,
    'info-text': BRAND_BLUE,
    'info-bg': '#E7F0F7',
    'info-border': '#B9D3E8',

    'selection-bg': '#C9DEEF',
    'scrollbar-thumb': '#C9D0D8',
    'scrollbar-thumb-hover': '#A9B2BD',
  },
  dark: {
    'bg-primary': '#0B0F14',
    'bg-secondary': '#0E1318',
    'bg-tertiary': '#18202A',
    'bg-elevated': '#11161D',
    'bg-input': '#0E1318',
    'bg-hover': '#18202A',
    'bg-active': '#12273A',

    'text-primary': '#E6EBF0',
    'text-secondary': '#A4AFBB',
    'text-tertiary': '#8A96A3',
    'text-inverse': '#0F1720',
    'text-link': '#62A8DD',
    'text-on-accent': '#FFFFFF',

    border: '#232C37',
    'border-subtle': '#1A212B',
    'border-hover': '#34404D',
    'border-control': '#6B7785',
    'border-focus': '#62A8DD',

    accent: BRAND_BLUE,
    'accent-hover': '#1F7BBF',
    'accent-text': '#62A8DD',
    'accent-subtle': '#12273A',
    'accent-muted': '#0F1D2A',

    success: '#4CC26E',
    'success-text': '#4CC26E',
    'success-bg': '#0F2618',
    'success-border': '#1E4A2C',
    warning: '#E0B24A',
    'warning-text': '#E0B24A',
    'warning-bg': '#2A200C',
    'warning-border': '#55431A',
    error: '#F2716A',
    'error-text': '#F2716A',
    'error-bg': '#2C1415',
    'error-border': '#5A2427',
    'error-fill': '#C2352E',
    'error-fill-hover': '#A82D27',
    'success-fill': '#1E7F42',
    'success-fill-hover': '#186A37',
    info: '#62A8DD',
    'info-text': '#62A8DD',
    'info-bg': '#12273A',
    'info-border': '#1F4462',

    'selection-bg': '#1F4462',
    'scrollbar-thumb': '#2B3542',
    'scrollbar-thumb-hover': '#3B4756',
  },
};

/** Categorical chart series, in order. Tuned per theme for 3:1 against the card. */
export const charts: { light: string[]; dark: string[] } = {
  light: ['#196BA7', '#0E8A7E', '#7A4FC9', '#B7791F', '#C2410C', '#5C6774', '#BE185D', '#4D7C0F'],
  dark: ['#62A8DD', '#3CC2B0', '#A98BEB', '#E0B24A', '#F0875A', '#A4AFBB', '#EC6FA6', '#94C24A'],
};

/** Shadows: one offset, soft blur; never a coloured glow. */
export const shadows: { light: Record<string, string>; dark: Record<string, string> } = {
  light: {
    sm: '0 1px 2px rgba(15, 23, 32, 0.06)',
    md: '0 2px 8px rgba(15, 23, 32, 0.08), 0 1px 2px rgba(15, 23, 32, 0.04)',
    lg: '0 8px 24px rgba(15, 23, 32, 0.10), 0 2px 6px rgba(15, 23, 32, 0.05)',
    xl: '0 16px 40px rgba(15, 23, 32, 0.14), 0 4px 12px rgba(15, 23, 32, 0.06)',
  },
  dark: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.40)',
    md: '0 2px 8px rgba(0, 0, 0, 0.45), 0 1px 2px rgba(0, 0, 0, 0.30)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.35)',
    xl: '0 16px 40px rgba(0, 0, 0, 0.65), 0 4px 12px rgba(0, 0, 0, 0.40)',
  },
};

export const typography = {
  fontSans: "'Grift', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontMono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  /** Self-hosted Grift faces the products use; everything else stays out of the build. */
  faces: [
    { weight: 400, style: 'normal', file: 'Grift-Regular.woff2' },
    { weight: 400, style: 'italic', file: 'Grift-Italic.woff2' },
    { weight: 500, style: 'normal', file: 'Grift-Medium.woff2' },
    { weight: 600, style: 'normal', file: 'Grift-SemiBold.woff2' },
    { weight: 700, style: 'normal', file: 'Grift-Bold.woff2' },
  ],
  /** Fixed rem scale at a 16 px root; body text is `base` (14 px). */
  size: {
    '2xs': '0.6875rem', // 11
    xs: '0.75rem', // 12
    sm: '0.8125rem', // 13
    base: '0.875rem', // 14
    lg: '1rem', // 16
    xl: '1.125rem', // 18
    '2xl': '1.25rem', // 20
    '3xl': '1.5rem', // 24
    '4xl': '1.875rem', // 30
  },
  weight: { normal: '400', medium: '500', semibold: '600', bold: '700' },
  leading: { tight: '1.25', normal: '1.45', relaxed: '1.6' },
  tracking: { tight: '-0.01em', normal: '0', wide: '0.04em' },
};

/** 4 px grid: `--space-N` is N × 4 px. */
export const space: Record<string, string> = {
  '0': '0',
  '0-5': '0.125rem',
  '1': '0.25rem',
  '1-5': '0.375rem',
  '2': '0.5rem',
  '2-5': '0.625rem',
  '3': '0.75rem',
  '4': '1rem',
  '5': '1.25rem',
  '6': '1.5rem',
  '8': '2rem',
  '10': '2.5rem',
  '12': '3rem',
  '16': '4rem',
  '20': '5rem',
  '24': '6rem',
};

export const radius: Record<string, string> = {
  sm: '4px',
  md: '6px',
  lg: '8px',
  xl: '12px',
  '2xl': '16px',
  full: '9999px',
};

export const motion = {
  duration: { instant: '75ms', fast: '120ms', normal: '200ms', slow: '300ms', slower: '400ms' },
  ease: {
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
    'in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
};

export const zIndex: Record<string, string> = {
  base: '0',
  dropdown: '100',
  sticky: '200',
  overlay: '300',
  modal: '400',
  toast: '500',
  tooltip: '600',
};

export const tokens = { colors, charts, shadows, typography, space, radius, motion, zIndex };
