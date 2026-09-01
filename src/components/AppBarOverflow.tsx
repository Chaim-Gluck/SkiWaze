import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { LANGUAGES, type Language } from '../i18n/config';
import { useLanguage } from '../i18n/language-context';
import { useThemeMode } from '../theme-context';

/**
 * The AppBar's language and theme controls, collapsed into one menu.
 *
 * Rendered only on narrow phones, where the bar cannot hold the brand, the resort picker and two
 * separate icon buttons at once — measured at ~546px of content against a ~360px portrait screen.
 * The resort picker deliberately stays out here: it is how you change mountain, so it must remain
 * one tap.
 *
 * The heading is bilingual for the same reason the language button is an icon: someone who cannot
 * read the current language still has to be able to find their way out of it.
 */
export function AppBarOverflow() {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();
  const { mode, toggle } = useThemeMode();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const close = () => setAnchor(null);
  const pick = (lng: Language) => { setLanguage(lng); close(); };

  return (
    <>
      <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label={t('app.more')}>
        <MoreVertIcon />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={close}>
        <ListSubheader sx={{ lineHeight: '32px' }}>Language / שפה</ListSubheader>
        {(Object.keys(LANGUAGES) as Language[]).map((lng) => (
          <MenuItem key={lng} selected={lng === language} onClick={() => pick(lng)} lang={lng}>
            {LANGUAGES[lng]}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem onClick={() => { toggle(); close(); }}>
          <ListItemIcon>{mode === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}</ListItemIcon>
          {mode === 'dark' ? t('app.themeLight') : t('app.themeDark')}
        </MenuItem>
      </Menu>
    </>
  );
}
