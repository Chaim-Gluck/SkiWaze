import { closureLabel } from '../routing/closures';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';

interface Props {
  closedKeys: string[];
  onReopen: (key: string) => void;
  onReopenAll: () => void;
  onLocate: (key: string) => void;
}

/** Lists lifts/runs the user marked closed, with reopen + locate. */
export function ClosedPanel({ closedKeys, onReopen, onReopenAll, onLocate }: Props) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Statuses are assumed open. Mark a run or lift closed (⊘ on a route step) and routes will avoid it.
      </Typography>

      {closedKeys.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing marked closed.
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="body2" color="text.secondary">{closedKeys.length} closed</Typography>
            <Button size="small" onClick={onReopenAll}>Reopen all</Button>
          </Box>
          <List dense disablePadding>
            {closedKeys.map((key) => (
              <ListItem
                key={key}
                disableGutters
                secondaryAction={
                  <IconButton edge="end" size="small" title="Reopen (remove closure)" onClick={() => onReopen(key)}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                }
              >
                <ListItemButton sx={{ borderRadius: 1 }} onClick={() => onLocate(key)} title="Show on map">
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: 'error.main', mr: 1, flexShrink: 0 }} />
                  <ListItemText primary={closureLabel(key)} slotProps={{ primary: { variant: 'body2' } }} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </>
      )}
    </Box>
  );
}

