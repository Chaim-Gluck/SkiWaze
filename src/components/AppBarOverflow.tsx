import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import Box from '@mui/material/Box';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LanguageIcon from '@mui/icons-material/Language';
import LightModeIcon from '@mui/icons-material/LightMode';
import LinkIcon from '@mui/icons-material/Link';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { LANGUAGES, type Language } from '../i18n/config';
import { useLanguage } from '../i18n/language-context';
import { useThemeMode } from '../theme-context';

interface Props {
  /** Narrow phones only: also fold the language picker and theme toggle in here. */
  compact: boolean;
  /** Number of custom links the user has drawn, shown so the menu still carries the signal the
   *  panel card's one-line summary used to. */
  linkCount: number;
  onCustomLinks: () => void;
  onAbout: () => void;
}

/**
 * The AppBar's overflow menu: occasional app-level actions, plus (on narrow phones) the language
 * and theme controls.
 *
 * It renders at every width, which it did not originally: it existed only below the breakpoint at
 * which the bar could no longer hold the brand, the resort picker and two separate icon buttons
 * (~546px of content against a ~360px portrait screen). Making it permanent gives things used once
 * in a session - custom links, About - a home that costs one icon button, instead of each one
 * claiming a panel card and, on mobile, one of the five bottom-nav slots. The resort picker
 * deliberately stays out here: it is how you change mountain, so it must remain one tap.
 *
 * The language row is bilingual for the same reason the language button is an icon: someone who
 * cannot read the current language still has to be able to find their way out of it. It is a
 * collapsed disclosure rather than a subheader plus a permanent list, so every row in the menu is
 * one line with one icon - the list was the only thing here taking three rows and carrying none.
 */
export function AppBarOverflow({ compact, linkCount, onCustomLinks, onAbout }: Props) {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();
  const { mode, toggle } = useThemeMode();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [langOpen, setLangOpen] = useState(false);

  const close = () => { setAnchor(null); setLangOpen(false); };
  const pick = (lng: Language) => { setLanguage(lng); close(); };
  const run = (fn: () => void) => { close(); fn(); };

  return (
    <>
      <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label={t('app.more')}>
        <MoreVertIcon />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={close}>
        {compact && (
          <MenuItem onClick={() => setLangOpen((v) => !v)}>
            <ListItemIcon><LanguageIcon fontSize="small" /></ListItemIcon>
            Language / שפה
            <Box sx={{ ml: 'auto', display: 'flex', color: 'text.secondary' }}>
              {langOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </Box>
          </MenuItem>
        )}
        {compact && (
          <Collapse in={langOpen} unmountOnExit>
            {(Object.keys(LANGUAGES) as Language[]).map((lng) => (
              <MenuItem key={lng} selected={lng === language} onClick={() => pick(lng)} lang={lng} sx={{ pl: 5.5 }}>
                {LANGUAGES[lng]}
              </MenuItem>
            ))}
          </Collapse>
        )}
        {compact && (
          <MenuItem onClick={() => { toggle(); close(); }}>
            <ListItemIcon>{mode === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}</ListItemIcon>
            {mode === 'dark' ? t('app.themeLight') : t('app.themeDark')}
          </MenuItem>
        )}
        {compact && <Divider />}
        <MenuItem onClick={() => run(onCustomLinks)}>
          <ListItemIcon><LinkIcon fontSize="small" /></ListItemIcon>
          {t('app.links.title')}
          {linkCount > 0 && (
            <Chip label={linkCount} size="small" sx={{ ml: 'auto', height: 20 }} />
          )}
        </MenuItem>
        <MenuItem onClick={() => run(onAbout)}>
          <ListItemIcon><InfoOutlinedIcon fontSize="small" /></ListItemIcon>
          {t('app.about.title')}
        </MenuItem>
      </Menu>
    </>
  );
}
