'use strict';
// Synthetic winapp 0.7.1 `ui inspect --json` trees for the M4 size bars. Their shape, node types,
// flags, name lengths and coordinates follow live captures made on 3 November 2026 (Notepad and
// Firefox at depth 6) and the Save As dialog from the head-to-head. Names are generic: the
// captures held the owner's tabs and bookmarks and are not committed. Selectors follow winapp's
// form (a three-letter type prefix, a short slug and four hex digits); bounds are screen pixels
// inside each window's recorded frame.

const PREFIX = { Button: 'btn', SplitButton: 'btn', Edit: 'txt', ListItem: 'itm', TreeItem: 'tri', MenuItem: 'mnu', TabItem: 'tab', Window: 'win',
  Document: 'doc', ComboBox: 'cmb', Hyperlink: 'lnk', Text: 'lbl', Group: 'grp', Pane: 'pan', ToolBar: 'tbr', List: 'lst', Tree: 'tre' };
let serial = 0, frame;
const start = (x, y, width, height) => { serial = 0; frame = { x, y, width, height }; };
const framed = root => Object.assign(root, frame);
// t: type, name, o: { a: automationId, c: className, inv, off, exp, tog, val, more, dis }, kids.
function n(type, name = '', o = {}, kids = []) {
  const id = (serial++).toString(16).padStart(4, '0');
  const width = 24 + (serial * 29) % Math.floor(frame.width / 2), height = 20 + (serial * 7) % 40;
  const at = frame.x + (serial * 37) % (frame.width - width), top = frame.y + (serial * 53) % (frame.height - height);
  return {
    type, ...(name ? { name } : {}), ...(o.a ? { automationId: o.a } : {}), ...(o.c ? { className: o.c } : {}),
    isEnabled: !o.dis, isOffscreen: !!o.off,
    ...(o.off ? { x: 0, y: 0, width: 0, height: 0 } : { x: at, y: top, width, height }),
    selector: `${PREFIX[type] ?? type.toLowerCase().slice(0, 3)}-${(o.a || name || type).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12)}-${id}`,
    ...(o.val ? { value: o.val } : {}), ...(o.inv ? { isInvokable: true } : {}),
    ...(o.exp ? { expandState: o.exp } : {}), ...(o.tog ? { toggleState: o.tog } : {}),
    ...(o.more ? { hasMoreChildren: true } : {}), children: kids,
  };
}
const times = (count, make) => Array.from({ length: count }, (_, i) => make(i));

// Notepad (Windows 11), TRACE-launched, depth 6: the Document is a direct child of a Pane.
function notepad() {
  start(114, 114, 1920, 1080);
  const b = (name, o = {}) => n('Button', name, { inv: true, c: 'Button', ...o });
  return framed(n('Window', 'Untitled - Notepad', { c: 'Notepad' }, [
    n('Pane', '', { c: 'NotepadTextBox' }, [n('Document', 'Text editor', { c: 'RichEditD2DPT', val: '' })]),
    n('Pane', '', { c: 'Microsoft.UI.Content.DesktopChildSiteBridge' }, [n('Pane', '', {}, [n('Tab', '', { a: 'Tabs', c: 'TabView' }, [
      n('List', '', { a: 'TabListView', c: 'ListView' }, [n('TabItem', 'Untitled. Unmodified.', { inv: true, c: 'ListViewItem' }, [
        n('Text', 'Untitled', { c: 'TextBlock' }), b('Close Tab', { a: 'CloseButton' })])]),
      b('Add New Tab', { a: 'AddButton' })])])]),
    n('Pane', '', { c: 'Microsoft.UI.Content.DesktopChildSiteBridge' }, [n('Pane', '', {}, [
      n('MenuBar', '', { a: 'MenuBar', c: 'MenuBar' }, ['File', 'Edit', 'View'].map(name => n('MenuItem', name, { inv: true, exp: 'collapsed', a: name, c: 'MenuBarItem' }))),
      b('Headings', { exp: 'collapsed' }), b('Lists', { exp: 'collapsed' }), b('Bold (Ctrl+B)', { tog: 'off' }), b('Italic (Ctrl+I)', { tog: 'off' }),
      b('Formatting toolbar settings', { tog: 'off' }), b('Link (Ctrl+K)', { tog: 'off' }), b('Clear', { exp: 'collapsed' }),
      b('Copilot', { exp: 'collapsed' }), b('Settings', { a: 'SettingsButton' }), n('Text', 'Ln 1, Col 1', { c: 'TextBlock' }),
      n('Text', '100%', { c: 'TextBlock' }), n('Text', 'Windows (CRLF)', { c: 'TextBlock' }), n('Text', 'UTF-8', { c: 'TextBlock' }),
      b('Character count'), b('Zoom'), b('Line ending'), b('Encoding')])]),
    n('Pane', '', { c: 'Microsoft.UI.Content.DesktopChildSiteBridge' }),
    n('TitleBar', 'Untitled - Notepad', { a: 'TitleBar' }, [b('Minimize', { a: 'Minimize-Restore' }), b('Maximize', { a: 'Maximize-Restore' }), b('Close', { a: 'Close' })]),
  ]));
}

// Firefox at example.com, depth 6. Gecko reports isInvokable on every node, including unnamed
// Groups and Separators; 25 context menus hang offscreen under the window.
function firefox() {
  start(1442, 0, 1436, 1798);
  const b = (name, o = {}) => n('Button', name, { inv: true, ...o });
  const menu = (name, o = {}) => n('Menu', name, { inv: true, off: true, ...o });
  const tab = name => n('TabItem', name, { inv: true, a: `tab-${name.toLowerCase().replace(/\W+/g, '-')}` }, [n('Group', '', { inv: true })]);
  return framed(n('Window', 'Example Domain — Mozilla Firefox', { a: 'main-window', c: 'MozillaWindowClass', inv: true, val: 'chrome://browser/content/browser.xhtml' }, [
    n('Pane', '', { dis: true, c: 'MozillaDropShadowWindowClass' }), n('Pane', 'Firefox content process host', { c: 'MozillaWindowClass' }),
    n('TitleBar', '', { a: 'titlebar', val: 'Example Domain' }, [n('MenuBar', 'System', { a: 'SystemMenuBar' }, [n('MenuItem', 'System', { inv: true, exp: 'collapsed' })]),
      b('Minimize', { a: 'minimize-btn' }), b('Maximize', { a: 'maximize-btn' }), b('Close', { a: 'close-btn' })]),
    ...times(25, i => menu('', { a: `context-menu-${i}` })),
    n('ToolBar', 'Menu bar', { inv: true, a: 'toolbar-menubar' }, [
      n('MenuBar', 'Application', { inv: true, off: true, a: 'main-menubar' }, ['File', 'Edit', 'View', 'History', 'Bookmarks', 'Tools', 'Help', 'Profiles']
        .map(name => n('MenuItem', name, { inv: true, off: true, exp: 'collapsed', a: `${name.toLowerCase()}-menu` }, [menu(name, { a: `menu-${name.toLowerCase()}-popup` })]))),
      b('Minimize', { off: true }), b('Maximize', { off: true }), b('Close', { off: true })]),
    n('ToolBar', 'Tab strip', { inv: true, a: 'TabsToolbar' }, [
      n('Tab', '', { inv: true, a: 'tabbrowser-tabs' }, [n('TabItem', 'Example Domain', { inv: true }, [b('Close tab')]),
        b('List all tabs and recently closed windows', { exp: 'collapsed', a: 'alltabs-button' }, [menu('All tabs')])]),
      n('Separator', '', { inv: true, a: 'tabs-separator' }), b('Open a new tab', { a: 'tabs-newtab-button' }),
      b('Minimize'), b('Maximize'), b('Close')]),
    n('ToolBar', 'Navigation', { inv: true, a: 'nav-bar' }, [
      b('Back', { a: 'back-button' }, [menu('Back')]), b('Forward', { exp: 'collapsed', a: 'forward-button' }, [menu('Forward')]),
      b('Reload', { exp: 'collapsed', dis: true, a: 'reload-button' }, [menu('History')]), b('Home', { a: 'home-button' }),
      n('Separator', '', { inv: true, a: 'nav-spacer-1' }),
      n('Group', '', { inv: true, a: 'urlbar-container' }, [b('Site information', { a: 'identity-box' }),
        n('ComboBox', 'Search with Google or enter address', { inv: true, exp: 'collapsed', a: 'urlbar-input', val: 'example.com' }, [n('Text', 'example.com', { inv: true })]),
        b('Translate this page', { a: 'translations-button' }), b('Edit this bookmark (Ctrl+D) and more', { a: 'star-button-box' }),
        b('Reader view is unavailable', { a: 'reader-mode-button' })]),
      n('Separator', '', { inv: true, a: 'nav-spacer-2' }), b('Pocket', { a: 'save-to-pocket' }),
      b('Downloads', { a: 'downloads-button' }), b('Extensions', { a: 'unified-extensions' }),
      b('Account and settings', { a: 'fxa-toolbar-menu' }), n('Group', '', { inv: true }), b('Open menu', { a: 'PanelUI-menu-button' })]),
    n('ToolBar', '', { inv: true, a: 'PersonalToolbar' }),
    n('Group', '', { inv: true }, [n('Tab', '', { inv: true }, ['Firefox View', 'Getting started', 'Mozilla Support', 'Release notes for Firefox', 'About Firefox']
      .map(tab)), tab('Customize Firefox now')]),
    n('Pane', '', { inv: true, a: 'tabbrowser-tabpanels' }, [
      n('Pane', '', { inv: true, a: 'panel-1' }, [n('Pane', '', { inv: true }, [n('Document', 'Example Domain', { val: 'https://example.com/' }, [
        n('Text', 'This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.'),
        n('Text', 'Example Domain is established to be used for illustrative examples in documents and other written material.'),
        n('Text', 'Please read the IANA notes for details.'),
        n('Text', 'Example domains are reserved and protected, so they never resolve to real services. This page exists to show such names, and you may refer to it freely in text and tests.'),
        n('Text', 'Use example.com, example.net and example.org in documentation: the three names are reserved for that purpose, and their pages say so in a short paragraph like this one here today.'),
        n('Text', 'The reserved names are kept by IANA. Further documentation explains how the reserved names may be used and why they appear in so many manuals, tutorials and examples.'),
        n('Hyperlink', 'More info…', { inv: true, val: 'https://www.iana.org/domains/example' })])])]),
      n('Pane', '', { inv: true, off: true }, [n('Pane', '', { inv: true, off: true }, [n('Document', 'New Tab', { off: true, val: 'about:home' }, [
        n('Group', '', { inv: true, off: true, a: 'newtab-root' }, [...times(4, () => n('Group', '', { inv: true, off: true, more: true })),
          n('List', '', { inv: true, off: true, more: true })])])])])]),
    n('Group', '', { inv: true, a: 'sidebar-main' }),
  ]));
}

// The Save As common dialog (#32770) followed from Notepad, depth 8, in details view. Its
// structure follows the head-to-head observation of 3 November 2026: Explorer lists a Name, Date
// modified, Type and Size Edit field (class UIProperty) under each row, and every scroll bar
// carries line and page buttons. The folder holds the recorded four files in three date groups.
// The live recheck of 3 November showed each group twice: the group and its UIGroupHeader, both
// expanded, the header holding a Collapse Group button and a Name field.
function saveAs() {
  start(9, 0, 1100, 700);
  const b = (name, o = {}) => n('Button', name, { inv: true, ...o });
  const prop = (name, val) => n('Edit', name, { c: 'UIProperty', val });
  const scroll = (name, c, parts) => n('ScrollBar', name, { c }, parts.map(part => part === 'Position' ? n('Thumb', part) : b(part)));
  const folder = (name, o = {}) => n('TreeItem', name, { exp: 'collapsed', ...o }, [n('Image', ''), n('Text', name)]);
  const file = i => n('ListItem', `Quarterly report draft ${i + 1}.txt`, { c: 'UIItem' }, [n('Image', ''),
    prop('Name', `Quarterly report draft ${i + 1}.txt`), prop('Date modified', '02/11/2026 14:05'), prop('Type', 'Text Document'), prop('Size', '4 KB')]);
  const group = (name, files) => n('Group', name, { c: 'UIGroupItem', exp: 'expanded' }, [
    n('Group', name, { c: 'UIGroupHeader', exp: 'expanded' }, [b('Collapse Group', { a: 'UIGroupButton', c: 'UIExpandoButton' }),
      n('Edit', 'Name', { a: 'System.ItemNameDisplay', c: 'UIProperty' })]), ...files]);
  const combo = (name, a, c, kids = []) => n('ComboBox', name, { a, c, exp: 'collapsed' }, [...kids, b('Open')]);
  return framed(n('Window', 'Save as', { c: '#32770' }, [
    n('Pane', '', { c: 'DUIViewWndClassName' }, [
      n('ToolBar', 'Command Module', { c: 'FolderBandModuleInner' }, [b('&Help', { c: 'Button3d' }),
        n('SplitButton', 'Details', { inv: true, c: 'ViewControl', exp: 'collapsed' }), b('View Slider', { c: 'Button3d' }),
        b('Organize', { c: 'AJOSplitButton', exp: 'collapsed' }), b('New folder', { c: 'AJOSplitButton' })]),
      n('Pane', 'Control Host', { c: 'ProperTreeHost' }, [n('Tree', 'Navigation Pane', { c: 'SysTreeView32' }, [
        scroll('Vertical', '', ['Line up', 'Page up', 'Position', 'Page down', 'Line down']),
        folder('Desktop', { exp: 'expanded' }), folder('Home folder of the signed-in user'), folder('AppData'), folder('Apps'),
        folder('Attachments'), folder('Desktop'), folder('Documents'), folder('Shared team folder'),
        ...['Downloads', 'Music', 'Pictures', 'Videos', 'This PC', 'Local Disk (C:)', 'Network'].map(name => folder(name, { off: true }))])]),
      n('Pane', 'Shell Folder View', { c: 'DUIListView' }, [n('List', 'Items View', { c: 'UIItemsView' }, [
        scroll('Horizontal', 'LineHScrollBar', ['Column left', 'Position', 'Page right', 'Column right']),
        scroll('Vertical', 'LineVScrollBar', ['Line up', 'Position', 'Page down', 'Line down']),
        n('Header', 'Header', { c: 'UIViewHeader' }, [n('SplitButton', 'Name', { inv: true, c: 'UIColumnHeader' }), b('Filter dropdown', { c: 'Button' }),
          n('SplitButton', 'Date modified', { inv: true, c: 'UIColumnHeader' }), b('Filter dropdown', { c: 'Button' }),
          n('SplitButton', 'Type', { inv: true, c: 'UIColumnHeader' })]),
        group('Yesterday', [file(0)]), group('Last week', times(2, i => file(i + 1))), group('Last month', [file(3)])])]),
      n('Pane', '', { c: 'DUIViewWndClassName' }, [
        combo('File name:', 'FileNameControlHost', 'AppControlHost', [n('Edit', 'File name:', { a: '1001', c: 'Edit', val: '*.txt' })]),
        combo('Save as type:', 'FileTypeControlHost', 'AppControlHost'),
        n('Tree', 'Save Fields', { c: 'SaveDialogPreviewMetadataInner' }),
        n('ToolBar', '', { c: 'ToolbarWindow32' }, [b('Hide Folders')]),
        combo('Encoding:', '', 'ComboBox'), b('Save', { a: '1', c: 'Button' }), b('Cancel', { a: '2', c: 'Button' }), n('Thumb', '', { c: 'ScrollBar' })]),
      n('Pane', '', { c: 'ReBarWindow32' }, [
        n('Pane', '', { c: 'TravelBand' }, [n('ToolBar', 'Navigation buttons', { c: 'ToolbarWindow32' }, [
          b('Back (Alt + Left Arrow)', { dis: true }), b('Forward (Alt + Right Arrow)', { dis: true }), b('Recent locations', { exp: 'collapsed' })])]),
        n('Pane', '', { c: 'UpBand' }, [n('ToolBar', 'Up band', { c: 'ToolbarWindow32' }, [b('Up to "Desktop" (Alt + Up Arrow)')])]),
        n('Pane', '', { c: 'Address Band Root' }, [n('ProgressBar', 'Loading', { c: 'msctls_progress32' }),
          n('Pane', '', { c: 'Breadcrumb Parent' }, [n('ToolBar', 'Address: Downloads', { c: 'ToolbarWindow32' }, [
            n('SplitButton', 'All locations', { inv: true, exp: 'collapsed' }), n('SplitButton', 'Downloads', { inv: true, exp: 'collapsed' })])]),
          n('ToolBar', 'Address band', { c: 'ToolbarWindow32' }, [b('Previous Locations', { exp: 'collapsed' }), b('Refresh "Downloads" (F5)')])]),
        n('Pane', '', { c: 'UniversalSearchBand' }, [n('Pane', '', { c: 'Search Box' }, [n('Pane', '', { c: 'SearchEditBoxWrapperClass' }, [
          n('Edit', 'Search Box', { c: 'SearchEditBox' }), b('Search', { c: 'Button' })])])])]),
    ]),
    n('TitleBar', '', {}, [n('MenuBar', 'System', {}, [n('MenuItem', 'System', { inv: true, exp: 'collapsed' })]), b('Close')]),
  ]));
}

module.exports = { notepad, firefox, saveAs };
