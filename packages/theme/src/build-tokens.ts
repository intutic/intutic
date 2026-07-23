import { tokens } from './tokens.js';
import * as fs from 'fs';
import * as path from 'path';

const cssContent = `/* Central Design Variables - Generated automatically by build-tokens.ts */

@font-face {
  font-family: 'Grift';
  font-style: normal;
  font-weight: 300;
  font-display: swap;
  src: url('/fonts/Grift-Light.woff2') format('woff2');
}

@font-face {
  font-family: 'Grift';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/Grift-Regular.woff2') format('woff2');
}

@font-face {
  font-family: 'Grift';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/Grift-Medium.woff2') format('woff2');
}

@font-face {
  font-family: 'Grift';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('/fonts/Grift-SemiBold.woff2') format('woff2');
}

@font-face {
  font-family: 'Grift';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/Grift-Bold.woff2') format('woff2');
}

@font-face {
  font-family: 'Grift';
  font-style: normal;
  font-weight: 900;
  font-display: swap;
  src: url('/fonts/Grift-Black.woff2') format('woff2');
}


:root {
  /* Fonts */
  --font-sans: ${tokens.typography.fontSans};
  --font-mono: ${tokens.typography.fontMono};

  /* Accent */
  --color-accent: ${tokens.colors.accent};
  --color-accent-rgb: ${tokens.colors.accentRgb};
  --color-accent-hover: ${tokens.colors.accentHover};
  --color-accent-subtle: ${tokens.colors.accentSubtleDark};
  --color-accent-muted: ${tokens.colors.accentMuted};
  --color-text-link: ${tokens.colors.accentLinkDark};

  /* Semantics */
  --color-success: ${tokens.colors.success};
  --color-success-bg: ${tokens.colors.successBg};
  --color-success-border: ${tokens.colors.successBorder};
  --color-success-text: ${tokens.colors.successText};

  --color-warning: ${tokens.colors.warning};
  --color-warning-bg: ${tokens.colors.warningBg};
  --color-warning-border: ${tokens.colors.warningBorder};
  --color-warning-text: ${tokens.colors.warningText};

  --color-error: ${tokens.colors.error};
  --color-error-bg: ${tokens.colors.errorBg};
  --color-error-border: ${tokens.colors.errorBorder};
  --color-error-text: ${tokens.colors.errorText};

  --color-info: ${tokens.colors.info};
  --color-info-bg: ${tokens.colors.infoBg};
  --color-info-border: ${tokens.colors.infoBorder};
  --color-info-text: ${tokens.colors.infoText};

  --color-constant-white: ${tokens.colors.constantWhite};
  --color-constant-black: ${tokens.colors.constantBlack};

  /* Neutrals & Surfaces (Default: Dark Mode) */
  --color-bg-primary: ${tokens.colors.bgPrimaryDark};
  --color-bg-secondary: ${tokens.colors.bgSecondaryDark};
  --color-bg-glass: ${tokens.colors.bgGlassDark};
  --color-bg-glass-elevated: ${tokens.colors.bgGlassElevatedDark};
  --color-text-primary: ${tokens.colors.textPrimaryDark};
  --color-text-secondary: ${tokens.colors.textSecondaryDark};
  --color-text-tertiary: ${tokens.colors.textTertiaryDark};
  --color-text-muted: ${tokens.colors.textTertiaryDark};
  --color-text-inverse: ${tokens.colors.textPrimaryLight};
  --color-border: ${tokens.colors.borderDark};
  --color-border-hover: ${tokens.colors.borderHoverDark};
}

[data-theme='light'],
.light {
  /* Accent override */
  --color-accent-subtle: ${tokens.colors.accentSubtleLight};
  --color-text-link: ${tokens.colors.accentLinkLight};

  /* Surfaces & Neutrals (Light Mode overrides) */
  --color-bg-primary: ${tokens.colors.bgPrimaryLight};
  --color-bg-secondary: ${tokens.colors.bgSecondaryLight};
  --color-bg-glass: ${tokens.colors.bgGlassLight};
  --color-bg-glass-elevated: ${tokens.colors.bgGlassElevatedLight};
  --color-text-primary: ${tokens.colors.textPrimaryLight};
  --color-text-secondary: ${tokens.colors.textSecondaryLight};
  --color-text-tertiary: ${tokens.colors.textTertiaryLight};
  --color-text-muted: ${tokens.colors.textTertiaryLight};
  --color-text-inverse: ${tokens.colors.textPrimaryDark};
  --color-border: ${tokens.colors.borderLight};
  --color-border-hover: ${tokens.colors.borderHoverLight};
}
`;

const distDir = path.resolve(process.cwd(), './dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

fs.writeFileSync(path.resolve(distDir, './variables.css'), cssContent);
console.log('Central CSS variables generated in dist/variables.css');
