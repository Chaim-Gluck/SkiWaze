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
import ListSubheader from '@mui/material/ListSubheader';
import IconButton from '@mui/material/IconButton';
import Checkbox from '@mui/material/Checkbox';
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

/**
 * One searchable picker. Multi-select with checkboxes and the menu held open, because closing a
 * sector means closing several neighbouring runs at once and reopening the list for each one is
 * the whole friction. Two consequences worth keeping:
 * - Options are the FULL list and already-closed items show ticked, rather than being filtered
 *   out. Removing an item on tick makes the list reflow under the finger that is about to tick
 *   the next one, which is exactly the adjacent-items case this exists for.
 * - Because closed items stay listed, unticking is a reopen, so this control does both jobs.
 */
function ClosePicker({
  items, closed, label, onPick, onUnpick,
}: {
  items: ClosableItem[];
  closed: Set<string>;
  label: string;
  onPick: (i: ClosableItem) => void;
  onUnpick: (key: string) => void;
}) {
  const { t } = useTranslation();
  const value = useMemo(() => items.filter((i) => closed.has(i.key)), [items, closed]);
  if (!items.length) return null;
  return (
    <Autocomplete
      multiple
      disableCloseOnSelect
      size="small"
      options={items}
      value={value}
      isOptionEqualToValue={(o, v) => o.key === v.key}
      clearOnBlur
      selectOnFocus
      handleHomeEndKeys
      disableClearable
      getOptionLabel={(o) => o.label}
      noOptionsText={t('closed.noneLeft')}
      // The selection is not state the box should display: every closed item is already listed
      // below with a reopen button, so chips in the input would be the same fact twice and would
      // grow the field without limit.
      renderValue={() => null}
      onChange={(_, _v, reason, details) => {
        const o = details?.option;
        if (!o) return;
        if (reason === 'selectOption') onPick(o);
        else if (reason === 'removeOption') onUnpick(o.key);
      }}
      renderOption={(props, o, { selected }) => {
        const { key, ...rest } = props as { key?: string } & Record<string, unknown>;
        return (
          <Box component="li" key={key} {...rest} sx={{ display: 'flex', alignItems: 'center' }}>
            <Checkbox size="small" checked={selected} sx={{ mr: 0.5, p: 0.5 }} />
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

/** Groups the closed list by kind. Keys carry their own prefix, so no lookup into `closable`. */
function groupOf(key: string): 'lift' | 'piste' | 'other' {
  if (key.startsWith('lift:')) return 'lift';
  if (key.startsWith('piste:')) return 'piste';
  return 'other';
}

/** Lists lifts/runs the user marked closed, with reopen + locate, plus pickers to close more. */
export function ClosedPanel({ closedKeys, closable, onClose, onReopen, onReopenAll, onLocate }: Props) {
  const { t } = useTranslation();
  const closed = useMemo(() => new Set(closedKeys), [closedKeys]);
  const lifts = useMemo(() => closable.filter((i) => i.kind === 'lift'), [closable]);
  const runs = useMemo(() => closable.filter((i) => i.kind === 'piste'), [closable]);

  // One list, grouped - never split into tabs. Checking what is shut is this card's whole job, so
  // the total must stay answerable at a glance; subheaders add the structure without hiding half.
  const groups = useMemo(() => ([
    { id: 'lift' as const, title: t('closed.groupLifts'), keys: closedKeys.filter((k) => groupOf(k) === 'lift') },
    { id: 'piste' as const, title: t('closed.groupRuns'), keys: closedKeys.filter((k) => groupOf(k) === 'piste') },
    { id: 'other' as const, title: t('closed.groupOther'), keys: closedKeys.filter((k) => groupOf(k) === 'other') },
  ].filter((g) => g.keys.length)), [closedKeys, t]);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {t('closed.intro')}
      </Typography>

      <ClosePicker items={lifts} closed={closed} label={t('closed.addLift')} onPick={onClose} onUnpick={onReopen} />
      <ClosePicker items={runs} closed={closed} label={t('closed.addRun')} onPick={onClose} onUnpick={onReopen} />

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
            {groups.map((g) => [
              // A lone group would be a header stating what the only section is - pure noise.
              groups.length > 1 ? (
                <ListSubheader
                  key={`h-${g.id}`}
                  disableGutters
                  disableSticky
                  sx={{ bgcolor: 'transparent', lineHeight: 1.8, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '.04em' }}
                >
                  {g.title}
                </ListSubheader>
              ) : null,
              ...g.keys.map((key) => (
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
              )),
            ])}
          </List>
        </>
      )}
    </Box>
  );
}

