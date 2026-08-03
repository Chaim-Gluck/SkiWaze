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
  children: ReactNode;
}

/**
 * Collapsible sidebar section (MUI Accordion, controlled). The header shows a leading icon,
 * the title, and — while collapsed — a muted one-line summary.
 */
export function AccordionSection({ title, icon, summary, open, onToggle, children }: Props) {
  return (
    <Accordion
      expanded={open}
      onChange={onToggle}
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
        expandIcon={<ExpandMoreIcon />}
        sx={{ '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1, my: 0.5, minWidth: 0 } }}
      >
        {icon ? (
          <Box sx={{ display: 'flex', color: 'text.secondary', flexShrink: 0 }} aria-hidden>
            {icon}
          </Box>
        ) : null}
        <Typography sx={{ fontWeight: 700 }}>{title}</Typography>
        {!open && summary ? (
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


