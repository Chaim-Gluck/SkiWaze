import type { ReactNode } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

interface Props {
  title: string;
  /** A leading MUI icon shown before the title. */
  icon?: ReactNode;
  /** Short one-line summary shown in the header while collapsed. */
  summary?: string | null;
  open: boolean;
  onToggle: () => void;
  /**
   * Render the body alone, with no header and no collapse. Used on mobile, where the bottom
   * navigation bar already selects the section and only the selected one is mounted — the
   * accordion header there would be a second copy of the tab you just tapped, above a chevron
   * that expands something already expanded.
   */
  bare?: boolean;
  /**
   * Show the header but never collapse. For the sections that are the panel's actual job (the
   * route form and its results): making them collapsible only ever offered the user the chance to
   * hide the thing they came for, and because the accordion set is exclusive, opening one of them
   * closed the other — so finding a route hid the form that found it.
   */
  pinned?: boolean;
  children: ReactNode;
}

/**
 * Sidebar section: a header with a leading icon and title, over a body. Collapsible by default
 * (a controlled MUI Accordion, with a muted one-line summary in the header while collapsed), but
 * `pinned` keeps it permanently open and `bare` drops the header entirely.
 */
export function AccordionSection({ title, icon, summary, open, onToggle, bare, pinned, children }: Props) {
  if (bare) return <div className="acc-body bare">{children}</div>;
  return (
    <Accordion
      expanded={pinned || open}
      onChange={pinned ? undefined : onToggle}
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        mb: 1,
        bgcolor: 'background.paper',
        '&:before': { display: 'none' },
      }}
    >
      <AccordionSummary
        expandIcon={pinned ? undefined : <ExpandMoreIcon />}
        // A pinned header is a heading, not a control: no pointer, no focus stop.
        tabIndex={pinned ? -1 : undefined}
        sx={{
          '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1, my: 0.5, minWidth: 0 },
          ...(pinned ? { cursor: 'default', pointerEvents: 'none' } : null),
        }}
      >
        {icon ? (
          <Box sx={{ display: 'flex', color: 'text.secondary', flexShrink: 0 }} aria-hidden>
            {icon}
          </Box>
        ) : null}
        <Typography sx={{ fontWeight: 700 }}>{title}</Typography>
        {!pinned && !open && summary ? (
          <Typography variant="body2" color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {summary}
          </Typography>
        ) : null}
      </AccordionSummary>
      <AccordionDetails className="acc-body" sx={{ pt: 0 }}>
        {children}
      </AccordionDetails>
    </Accordion>
  );
}


