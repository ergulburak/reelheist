// Themes are CSS variable sets in styles/tokens.css, selected by <html data-theme>.

export const THEMES = ['red', 'black-beige', 'beige-black', 'midnight', 'emerald', 'amethyst', 'amber', 'snow', 'rose'];

export function applyTheme(name, doc = document) {
  const theme = THEMES.includes(name) ? name : 'red';
  doc.documentElement.dataset.theme = theme;
  return theme;
}
