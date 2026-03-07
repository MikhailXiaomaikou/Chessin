import { Menu, BrowserWindow } from 'electron'

export function createMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Chess GUI',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Game',
          accelerator: 'CmdOrCtrl+N',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:new-game')
          }
        },
        { type: 'separator' },
        {
          label: 'Open PGN...',
          accelerator: 'CmdOrCtrl+O',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:open-pgn')
          }
        },
        {
          label: 'Save PGN...',
          accelerator: 'CmdOrCtrl+S',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:save-pgn')
          }
        },
        { type: 'separator' },
        {
          label: 'Open Database...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:open-database')
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        {
          label: 'Copy FEN',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:copy-fen')
          }
        },
        {
          label: 'Paste FEN',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:paste-fen')
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Flip Board',
          accelerator: 'F',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:flip-board')
          }
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Game',
      submenu: [
        {
          label: 'Go to Start',
          accelerator: 'Home',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:go-start')
          }
        },
        {
          label: 'Go Back',
          accelerator: 'Left',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:go-back')
          }
        },
        {
          label: 'Go Forward',
          accelerator: 'Right',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:go-forward')
          }
        },
        {
          label: 'Go to End',
          accelerator: 'End',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:go-end')
          }
        }
      ]
    },
    {
      label: 'Engine',
      submenu: [
        {
          label: 'Toggle Analysis',
          accelerator: 'Space',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:toggle-engine')
          }
        },
        { type: 'separator' },
        {
          label: 'Add Engine...',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:add-engine')
          }
        },
        {
          label: 'Engine Settings...',
          click: (): void => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:engine-settings')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
