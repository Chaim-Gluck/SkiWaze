import { useTranslation } from 'react-i18next';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Logo } from './Logo';
import { SHIELD_SLOT } from '../utils/text';

/** The author's public GitHub profile. Deliberately NOT the repository: it is private, so a link
 *  to it 404s for every visitor, which reads as a broken app rather than as a closed source. */
const PROFILE_URL = 'https://github.com/Chaim-Gluck';

/** A proper noun, so it is not in the catalogue - it is the same in every language. */
const AUTHOR = 'Chaim Gluck';

interface Props {
  open: boolean;
  onClose: () => void;
  dir: 'ltr' | 'rtl';
}

export function AboutDialog({ open, onClose, dir }: Props) {
  const { t } = useTranslation();
  // The name IS the link, so the credit reads as one phrase instead of a name followed by a
  // separate "GitHub" hop. Where the name sits in that phrase differs by language, so the
  // catalogue places it via the slot character and we only split on it - never at a fixed offset.
  const credit = t('app.about.credit', { name: SHIELD_SLOT }).split(SHIELD_SLOT);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth slotProps={{ paper: { dir } }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Logo className="logo-mark" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Typography variant="body2">{t('app.about.what')}</Typography>
          <Typography variant="body2" color="text.secondary">{t('app.about.data')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {credit[0]}
            {/* dir="ltr" isolates the Latin name inside Hebrew prose, so the year that follows it
                still flows RTL and a Hebrew reader meets the name before the year. */}
            <Link href={PROFILE_URL} target="_blank" rel="noopener noreferrer" dir="ltr">
              {AUTHOR}
            </Link>
            {credit[1]}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
