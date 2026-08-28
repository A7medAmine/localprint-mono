@echo off
title PrintShop Hub Setup
color 0A

:: Enhanced installation script with better error handling
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════╗
echo  ║                PrintShop Hub Installation Wizard                ║
echo  ║                     Print Shop Management System                 ║
echo  ╚════════════════════════════════════════════════════════════════╝
echo.

:: Check administrator privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  ❌ ERROR: Administrator privileges required!
    echo.
    echo  Please right-click this script and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo  ✅ Running with administrator privileges
echo.

:: Set installation directory
set INSTALL_DIR=%~dp0
set INSTALL_DIR=%INSTALL_DIR:~0,-1%

echo  📁 Installation directory: %INSTALL_DIR%
echo.

:: Check Node.js installation
echo  🔍 Checking Node.js installation...
node --version >nul 2>&1
if %errorLevel% neq 0 (
    echo  ❌ Node.js is not installed!
    echo.
    echo  Please download and install Node.js from:
    echo  https://nodejs.org/
    echo.
    echo  After installing Node.js, run this script again.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i

echo  ✅ Node.js %NODE_VERSION% is installed
echo  ✅ npm %NPM_VERSION% is installed
echo.

:: Install dependencies
echo  📦 Installing application dependencies...
cd /d "%INSTALL_DIR%"
call npm install
if %errorLevel% neq 0 (
    echo  ❌ ERROR: Failed to install dependencies
    echo.
    echo  Please check your internet connection and try again.
    echo.
    pause
    exit /b 1
)

echo  ✅ Dependencies installed successfully
echo.

:: Create startup script
echo  🚀 Creating startup script...
set STARTUP_SCRIPT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PrintShopHub.bat

(
echo @echo off
echo title PrintShop Hub
echo cd /d "%INSTALL_DIR%"
echo echo Starting PrintShop Hub...
echo start /min cmd /c "npm run dev"
echo timeout /t 5 /nobreak ^>nul
echo start http://localhost:3000
) > "%STARTUP_SCRIPT%"

echo  ✅ Startup script created
echo.

:: Create desktop shortcut
echo  🖥️  Creating desktop shortcut...
set DESKTOP_SHORTCUT=%USERPROFILE%\Desktop\PrintShop Hub.lnk

powershell -Command "& {$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%DESKTOP_SHORTCUT%'); $Shortcut.TargetPath = '%STARTUP_SCRIPT%'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.Description = 'PrintShop Hub - Print Shop Management System'; $Shortcut.Save();}" 2>nul

if %errorLevel% == 0 (
    echo  ✅ Desktop shortcut created
) else (
    echo  ⚠️  WARNING: Could not create desktop shortcut
)
echo.

:: Create uninstall script
echo  🗑️  Creating uninstall script...
set UNINSTALL_SCRIPT=%INSTALL_DIR%\uninstall.bat

(
echo @echo off
echo title PrintShop Hub Uninstall
echo color 0C
echo cls
echo echo.
echo echo  ╔════════════════════════════════════════════════════════════════╗
echo echo  ║                PrintShop Hub Uninstall Wizard                  ║
echo echo  ╚════════════════════════════════════════════════════════════════╝
echo echo.
echo echo  🗑️  Removing startup script...
echo del "%STARTUP_SCRIPT%" 2^>nul
echo echo.
echo echo  🗑️  Removing desktop shortcut...
echo del "%DESKTOP_SHORTCUT%" 2^>nul
echo echo.
echo echo  ✅ PrintShop Hub has been uninstalled from startup
echo echo.
echo echo  You can safely delete this folder: %INSTALL_DIR%
echo echo.
echo pause
) > "%UNINSTALL_SCRIPT%"

echo  ✅ Uninstall script created
echo.

:: Start the application
echo  🚀 Starting PrintShop Hub...
cd /d "%INSTALL_DIR%"
start /min cmd /c "npm run dev"

echo  ⏳ Waiting for services to start...
timeout /t 8 /nobreak >nul

:: Check services
echo  🔍 Checking services...
curl -s http://localhost:3001 >nul 2>&1
if %errorLevel% == 0 (
    echo  ✅ Backend server is running (port 3001)
) else (
    echo  ⚠️  Backend server may still be starting...
)

curl -s http://localhost:3000 >nul 2>&1
if %errorLevel% == 0 (
    echo  ✅ Frontend is running (port 3000)
) else (
    echo  ⚠️  Frontend may still be starting...
)

echo.
echo  ╔════════════════════════════════════════════════════════════════╗
echo  ║                    INSTALLATION COMPLETE!                     ║
echo  ╚════════════════════════════════════════════════════════════════╝
echo.
echo  🎉 PrintShop Hub has been successfully installed!
echo.
echo  📋 What was installed:
echo     • Application dependencies
echo     • Windows startup configuration
echo     • Desktop shortcut
echo     • Uninstall script
echo.
echo  🚀 The application will start automatically when you log into Windows.
echo.
echo  🖱️  To start now: Double-click the desktop shortcut
echo  🌐  Or visit: http://localhost:3000
echo.
echo  🗑️  To uninstall: Run uninstall.bat from this folder
echo.
echo  Press any key to open PrintShop Hub in your browser...
pause >nul

start http://localhost:3000

echo.
echo  🎯 Setup complete! PrintShop Hub is now running.
echo.
echo  💡 Tips:
echo     • The application runs in the background
echo     • Check the system tray for running processes
echo     • Use the desktop shortcut for quick access
echo.
pause
