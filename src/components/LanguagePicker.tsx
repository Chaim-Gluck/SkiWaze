import { useState } from 'react';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import LanguageIcon from '@mui/icons-material/Language';
import { LANGUAGES, type Language } from '../i18n/config';
import { useLanguage } from '../i18n/language-context';

/**
 * Language picker for the AppBar.
 *
 * Deliberately an icon, not a word: someone who cannot read the current language still has to be
 * able to find it. Each option is written in its own language for the same reason.
 */
export function LanguagePicker() {
  const { language, setLanguage } = useLanguage();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const pick = (lng: Language) => {
    setLanguage(lng);
    setAnchor(null);
  };

  return (
    <>
      <Tooltip title="Language / שפה">
        <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label="Language">
          <LanguageIcon />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {(Object.keys(LANGUAGES) as Language[]).map((lng) => (
          <MenuItem key={lng} selected={lng === language} onClick={() => pick(lng)} lang={lng}>
            {LANGUAGES[lng]}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
