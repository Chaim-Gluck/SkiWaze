import { useTranslation } from 'react-i18next';
import { closureLabel } from '../routing/closures';
import { tr } from '../utils/text';
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
  const { t } = useTranslation();
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('closed.intro')}
      </Typography>

      {closedKeys.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('closed.empty')}
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="body2" color="text.secondary">{t('closed.count', { count: closedKeys.length })}</Typography>
            <Button size="small" onClick={onReopenAll}>{t('closed.reopenAll')}</Button>
          </Box>
          <List dense disablePadding>
            {closedKeys.map((key) => (
              <ListItem
                key={key}
                disableGutters
                secondaryAction={
                  <IconButton edge="end" size="small" title={t('closed.reopen')} onClick={() => onReopen(key)}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                }
              >
                <ListItemButton sx={{ borderRadius: 1 }} onClick={() => onLocate(key)} title={t('common.showOnMap')}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: 'error.main', mr: 1, flexShrink: 0 }} />
                  <ListItemText primary={tr(t, closureLabel(key))} slotProps={{ primary: { variant: 'body2' } }} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </>
      )}
    </Box>
  );
}

