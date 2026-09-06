import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { closureLabel, type ClosableItem } from '../routing/closures';
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
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';

interface Props {
  closedKeys: string[];
  /** Every named lift and run in the resort, so anything can be closed without routing over it. */
  closable: ClosableItem[];
  onClose: (item: ClosableItem) => void;
  onReopen: (key: string) => void;
  onReopenAll: () => void;
  onLocate: (key: string) => void;
}

/** Kept in step with MapView's SLOPE_COLOR_EXPR. Local on purpose: this is presentation only. */
const SLOPE_HEX: Record<string, string> = {
  green: '#2e7d32', blue: '#1565c0', red: '#d32f2f', black: '#111111', unknown: '#ff9800',
};

/** A run's colour, or a neutral dot for a lift - the fastest way to tell two same-named runs apart. */
function Swatch({ item }: { item: ClosableItem }) {
  const c = item.kind === 'piste' ? SLOPE_HEX[item.color ?? 'unknown'] : undefined;
  return (
    <Box
      sx={{
        width: 10, height: 10, borderRadius: '50%', mr: 1, flexShrink: 0,
        bgcolor: c ?? 'text.disabled',
        border: c ? '1px solid rgba(128,128,128,.5)' : undefined,
      }}
    />
  );
}

/** One searchable picker. Already-closed items are dropped from the options rather than disabled. */
function ClosePicker({
  items, closed, label, onPick,
}: { items: ClosableItem[]; closed: Set<string>; label: string; onPick: (i: ClosableItem) => void }) {
  const { t } = useTranslation();
  const options = useMemo(() => items.filter((i) => !closed.has(i.key)), [items, closed]);
  if (!items.length) return null;
  return (
    <Autocomplete
      size="small"
      options={options}
      // Controlled to the empty value: picking is an ACTION (it closes the thing), not a selection
      // that should stay in the box. Leaving the name behind would read as "this is still armed",
      // and the closure it created is already listed below.
      value={null}
      blurOnSelect
      clearOnBlur
      selectOnFocus
      handleHomeEndKeys
      getOptionLabel={(o) => o.label}
      noOptionsText={t('closed.noneLeft')}
      onChange={(_, v) => { if (v) onPick(v); }}
      renderOption={(props, o) => {
        const { key, ...rest } = props as { key?: string } & Record<string, unknown>;
        return (
          <Box component="li" key={key} {...rest} sx={{ display: 'flex', alignItems: 'center' }}>
            <Swatch item={o} />
            <Typography variant="body2" noWrap>{o.label}</Typography>
          </Box>
        );
      }}
      renderInput={(params) => <TextField {...params} label={label} placeholder={t('closed.search')} />}
      sx={{ mb: 1.5 }}
    />
  );
}

/** Lists lifts/runs the user marked closed, with reopen + locate, plus pickers to close more. */
export function ClosedPanel({ closedKeys, closable, onClose, onReopen, onReopenAll, onLocate }: Props) {
  const { t } = useTranslation();
  const closed = useMemo(() => new Set(closedKeys), [closedKeys]);
  const lifts = useMemo(() => closable.filter((i) => i.kind === 'lift'), [closable]);
  const runs = useMemo(() => closable.filter((i) => i.kind === 'piste'), [closable]);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {t('closed.intro')}
      </Typography>

      <ClosePicker items={lifts} closed={closed} label={t('closed.addLift')} onPick={onClose} />
      <ClosePicker items={runs} closed={closed} label={t('closed.addRun')} onPick={onClose} />

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

