import type { SxProps, Theme } from '@mui/material/styles';

/**
 * Centre a portalled overlay over the MAP rather than over the viewport.
 *
 * A MUI Dialog or Snackbar is portalled to `<body>`, so it centres on the whole window. On desktop
 * the map is not the whole window - a fixed sidebar sits beside it - so a "centred" dialog lands
 * noticeably off-centre of the map it is talking about. Both offenders were overlays that appear
 * before the user has touched anything (the assumed-open status notice on loading a resort, and the
 * Preview offer), which is exactly when a misplaced element reads as a layout bug.
 *
 * The shift is done with **padding on the inline-start side**, not with `left` or `transform`:
 *  - It composes with whatever positioning MUI already applies, instead of overriding it, so it
 *    cannot break when MUI changes how it centres a Dialog container or a Snackbar root.
 *  - A flex centring container (`.MuiDialog-container`) shrinks its content box, moving the centre
 *    by half the padding; a `left:50%; translateX(-50%)` root (the Snackbar) grows by the padding
 *    and so also moves its content by half. One mechanism, both cases, half of the sidebar width.
 *  - It is a **logical** property, so it flips with the writing direction on its own. That matters:
 *    the sidebar is the flex row's first child, so in Hebrew it renders on the right and the map
 *    centre moves the other way. A physical `paddingLeft` would push RTL the wrong way.
 *
 * Returns nothing on mobile, where the panel is a bottom sheet and the map spans the full width.
 */
export function mapCenteredSx(isMobile: boolean, selector?: string): SxProps<Theme> {
  if (isMobile) return {};
  const shift = { paddingInlineStart: 'var(--sidebar-w)' };
  return selector ? { [selector]: shift } : shift;
}
