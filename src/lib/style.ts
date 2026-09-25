/**
 * How the strip looks: one template (photo arrangement) and one theme
 * (canvas palette). Both peers compose the strip independently, so the
 * chosen style travels over the data channel — see `BoothMessage`'s
 * `style` variant — and is persisted locally between visits.
 */

export type TemplateId = 'grid' | 'film' | 'hero';
export type ThemeId = 'paper' | 'noir' | 'pop' | 'mint';

export interface StripStyle {
  template: TemplateId;
  theme: ThemeId;
}

/** Everything the canvas needs to paint one theme. */
export interface ThemePalette {
  id: ThemeId;
  label: string;
  /** Sheet colour behind everything. */
  paper: string;
  /** The mount board each photo sits on. */
  mat: string;
  ink: string;
  inkSoft: string;
  accent: string;
  /** Text drawn on top of `accent`. */
  onAccent: string;
  /** Fill used when a frame hasn't arrived yet. */
  placeholder: string;
  /** Two swatch colours for the picker chip. */
  swatch: [string, string];
  /** Paper grain blend: dark sheets need `screen` or the noise vanishes. */
  grain: 'multiply' | 'screen';
}

export interface TemplateInfo {
  id: TemplateId;
  label: string;
  blurb: string;
}

export const TEMPLATES: readonly TemplateInfo[] = [
  { id: 'grid', label: 'Classic', blurb: 'Four rows · you and them' },
  { id: 'film', label: 'Contact', blurb: 'Edge to edge · sprocket rail' },
  { id: 'hero', label: 'Hero', blurb: 'Last shot big · three small' },
];

export const THEMES: readonly ThemePalette[] = [
  {
    id: 'paper',
    label: 'Paper',
    paper: '#efe9dd',
    mat: '#fbf9f3',
    ink: '#14120e',
    inkSoft: '#6b655a',
    accent: '#e8380d',
    onAccent: '#ffffff',
    placeholder: '#d9d2c3',
    swatch: ['#efe9dd', '#e8380d'],
    grain: 'multiply',
  },
  {
    id: 'noir',
    label: 'Noir',
    paper: '#12110f',
    mat: '#1e1c18',
    ink: '#f2efe7',
    inkSoft: '#9b958a',
    accent: '#f5b800',
    onAccent: '#14120e',
    placeholder: '#2b2924',
    swatch: ['#12110f', '#f5b800'],
    grain: 'screen',
  },
  {
    id: 'pop',
    label: 'Pop',
    paper: '#ffffff',
    mat: '#f4f1ff',
    ink: '#14120e',
    inkSoft: '#5a5470',
    accent: '#ff2e88',
    onAccent: '#ffffff',
    placeholder: '#e6e2f5',
    swatch: ['#ffffff', '#ff2e88'],
    grain: 'multiply',
  },
  {
    id: 'mint',
    label: 'Mint',
    paper: '#e7f4ee',
    mat: '#ffffff',
    ink: '#0f2f2a',
    inkSoft: '#4c6f68',
    accent: '#ff5a3c',
    onAccent: '#ffffff',
    placeholder: '#cfe4dc',
    swatch: ['#e7f4ee', '#ff5a3c'],
    grain: 'multiply',
  },
];

export const DEFAULT_STYLE: StripStyle = { template: 'grid', theme: 'paper' };

const STYLE_KEY = 'pb:style';

export function isTemplateId(value: unknown): value is TemplateId {
  return TEMPLATES.some((t) => t.id === value);
}

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export function normalizeStyle(value: unknown): StripStyle {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_STYLE };
  const { template, theme } = value as { template?: unknown; theme?: unknown };
  return {
    template: isTemplateId(template) ? template : DEFAULT_STYLE.template,
    theme: isThemeId(theme) ? theme : DEFAULT_STYLE.theme,
  };
}

export function getTheme(id: ThemeId): ThemePalette {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function getTemplate(id: TemplateId): TemplateInfo {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

export function loadStyle(): StripStyle {
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    if (!raw) return { ...DEFAULT_STYLE };
    return normalizeStyle(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STYLE };
  }
}

export function saveStyle(style: StripStyle): void {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(normalizeStyle(style)));
  } catch {
    /* private mode — the choice simply won't outlive the tab */
  }
}
