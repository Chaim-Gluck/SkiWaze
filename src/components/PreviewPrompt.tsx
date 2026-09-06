import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleFilled';

/** Why we are offering Preview — the two situations read very differently to the user. */
export type PreviewReason = 'noFix' | 'far';

interface Props {
  reason: PreviewReason | null;
  /** Resort name, used to make the "you are far away" wording concrete. */
  resortName: string;
  onAccept: () => void;
  onDecline: () => void;
}

/**
 * Offers Preview mode at the moment it becomes relevant, rather than hiding it behind a setting.
 *
 * A checkbox in preferences would require the user to already know the feature exists; this appears
 * exactly when navigation cannot work — no location fix, or a perfectly good fix a long way from the
 * mountain (planning at home, which is the case worth serving). It is deliberately NOT offered when
 * the user has a real fix inside the resort: a simulated position while someone is actually skiing
 * is a safety hazard, and being off-route is a reroute, never a simulation.
 */
export function PreviewPrompt({ reason, resortName, onAccept, onDecline }: Props) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!reason} onClose={onDecline} maxWidth="xs">
      <DialogTitle sx={{ fontWeight: 800 }}>{t('preview.promptTitle')}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {reason === 'far'
            ? t('preview.promptFar', { resort: resortName })
            : t('preview.promptNoFix')}
        </DialogContentText>
        <DialogContentText sx={{ mt: 1.5 }} variant="body2">
          {t('preview.promptHint')}
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onDecline} color="inherit" sx={{ textTransform: 'none', fontWeight: 700 }}>
          {t('preview.promptDecline')}
        </Button>
        <Button
          onClick={onAccept}
          variant="contained"
          startIcon={<PlayCircleOutlineIcon />}
          sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 5 }}
        >
          {t('preview.promptAccept')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
