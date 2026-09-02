import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import SwipeableDrawer from '@mui/material/SwipeableDrawer';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';

/**
 * The sheet's height, as a share of the viewport. **One** value, not a per-section one: before this
 * the sheet had `max-height: 82vh` and no height, so its height was its content and it jumped 458px
 * between tabs (Links 232px, Filters 689px) — the panel leapt around the screen and the map behind
 * it went from 95px tall to 537px. With a single height, switching tabs moves nothing at all.
 *
 * 68vh is the tallest section (Preferences, measured 495px on a 390x844 phone) plus a little. It
 * was originally two heights, a peek and a tall one for Preferences, because Preferences needed
 * ~930px; collapsing its measured-speeds diagnostics table removed that need, and with it the
 * second height. If a section ever genuinely cannot fit, prefer a disclosure inside the section
 * over a second sheet height — the second height is the thing that makes the panel jump.
 */
const SHEET_VH = 68;

/** The bottom navigation bar's own height, plus the phone's home indicator. */
const NAV_H = 'calc(56px + env(safe-area-inset-bottom, 0px))';

interface Props {
  /** Below the tablet breakpoint the panel is a bottom sheet; above it, a fixed left column. */
  isMobile: boolean;
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  /** Shown in the sheet's own header. The desktop column has per-section headers instead. */
  title: string;
  /** The selected section's icon, shown beside the title — the same one its desktop header uses. */
  icon?: ReactNode;
  children: ReactNode;
}

/**
 * The container the control sections live in: a plain column on desktop, a bottom sheet on phones.
 * Only the shell differs between the two — the sections themselves are rendered once, as children.
 *
 * The sheet is a MUI SwipeableDrawer rather than the hand-rolled CSS panel it replaces, so the
 * transition, focus handling and swipe-to-dismiss are component behaviour.
 *
 * It is deliberately **non-modal**: the whole argument for a sheet that stops short of the top is
 * that you can still see and pan the map above it, which a backdrop would prevent. A Modal's root
 * still covers the viewport even with `hideBackdrop`, so the root is given `pointerEvents: none`
 * and the paper takes them back — without that the map is dead under a backdrop that isn't drawn.
 */
export function PanelShell({ isMobile, open, onClose, onOpen, title, icon, children }: Props) {
  if (!isMobile) return <aside className="sidebar">{children}</aside>;

  return (
    <SwipeableDrawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      onOpen={onOpen}
      // The edge swipe would fight the map's own pan gesture; the nav bar is how the sheet opens.
      disableSwipeToOpen
      ModalProps={{
        keepMounted: true,
        hideBackdrop: true,
        disableEnforceFocus: true,
        disableAutoFocus: true,
        disableRestoreFocus: true,
        disableScrollLock: true,
      }}
      sx={{ pointerEvents: 'none' }}
      slotProps={{
        paper: {
          sx: {
            pointerEvents: 'auto',
            // Sit ON the nav bar, not behind it. Running the sheet to the bottom of the screen
            // meant its last 72px were permanently under an opaque bar, so that much padding had
            // to be added back inside the scroll area — dead space that pushed the densest
            // section (Preferences) into scrolling when it would otherwise have fitted.
            bottom: NAV_H,
            height: `calc(${SHEET_VH}vh - ${NAV_H})`,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        },
      }}
    >
      {/* Grabber + one title row. The title is the section's, not the app's: the bottom navigation
          bar below already says which tab is selected, so anything more repeats it. */}
      <Box sx={{ flex: '0 0 auto', pt: 1, px: 1.5, pb: 0.5 }}>
        <Box sx={{ width: 44, height: 5, borderRadius: 3, bgcolor: 'divider', mx: 'auto', mb: 1 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {icon ? (
            <Box sx={{ display: 'flex', color: 'text.secondary', flexShrink: 0 }} aria-hidden>
              {icon}
            </Box>
          ) : null}
          <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>
            {title}
          </Typography>
          <IconButton size="small" onClick={onClose} aria-label={title}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 1.5, pb: 1.5 }}>
        {children}
      </Box>
    </SwipeableDrawer>
  );
}
