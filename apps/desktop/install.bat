@echo off
echo ============================================
echo PrintShop Hub Installation Script
echo ============================================
echo.

:: Check if running as administrator
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Running with administrator privileges...
) else (
    echo ERROR: Please run this script as administrator!
    echo Right-click the script and select "Run as administrator"
    pause
    exit /b 1
)

:: Get the current directory where the script is located
set INSTALL_DIR=%~dp0
set INSTALL_DIR=%INSTALL_DIR:~0,-1%

echo Installation directory: %INSTALL_DIR%
echo.

:: Check if Node.js is installed
node --version >nul 2>&1
if %errorLevel% neq 0 (
    echo Node.js is not installed. Please install Node.js first from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Node.js is installed.
node --version
npm --version
echo.

:: Install dependencies
echo Installing dependencies...
cd /d "%INSTALL_DIR%"
call npm install
if %errorLevel% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)
echo Dependencies installed successfully.
echo.

:: Create startup script
echo Creating startup script...
set STARTUP_SCRIPT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PrintShopHub.bat

(
echo @echo off
echo cd /d "%INSTALL_DIR%"
echo start /min cmd /c "npm run dev"
echo.
echo REM Wait a moment for services to start
echo timeout /t 3 /nobreak >nul
echo.
echo REM Open browser automatically
echo start http://localhost:3000
) > "%STARTUP_SCRIPT%"

echo Startup script created: %STARTUP_SCRIPT%
echo.

:: Create desktop shortcut
echo Creating desktop shortcut...
set DESKTOP_SHORTCUT=%USERPROFILE%\Desktop\PrintShop Hub.lnk

powershell -Command "
$WshShell = New-Object -comObject WScript.Shell;
$Shortcut = $WshShell.CreateShortcut('%DESKTOP_SHORTCUT%');
$Shortcut.TargetPath = '%STARTUP_SCRIPT%';
$Shortcut.WorkingDirectory = '%INSTALL_DIR%';
$Shortcut.IconLocation = '%INSTALL_DIR%\public\icon.ico';
$Shortcut.Description = 'PrintShop Hub - Print Shop Management System';
$Shortcut.Save();
"

if %errorLevel% == 0 (
    echo Desktop shortcut created: %DESKTOP_SHORTCUT%
) else (
    echo WARNING: Could not create desktop shortcut (icon.ico may not exist)
)
echo.

:: Create uninstall script
echo Creating uninstall script...
set UNINSTALL_SCRIPT=%INSTALL_DIR%\uninstall.bat

(
echo @echo off
echo echo ============================================
echo echo PrintShop Hub Uninstallation Script
echo echo ============================================
echo echo.
echo echo Removing startup script...
echo del "%STARTUP_SCRIPT%" 2>nul
echo echo.
echo echo Removing desktop shortcut...
echo del "%DESKTOP_SHORTCUT%" 2>nul
echo echo.
echo echo PrintShop Hub has been uninstalled from startup.
echo echo You can safely delete this folder: %INSTALL_DIR%
echo echo.
echo pause
) > "%UNINSTALL_SCRIPT%"

echo Uninstall script created: %UNINSTALL_SCRIPT%
echo.

:: Test the application
echo Testing application startup...
cd /d "%INSTALL_DIR%"
start /min cmd /c "npm run dev"

echo Waiting for application to start...
timeout /t 5 /nobreak >nul

:: Check if services are running
curl -s http://localhost:3001 >nul 2>&1
if %errorLevel% == 0 (
    echo [SUCCESS] Backend server is running on port 3001
) else (
    echo [WARNING] Backend server may not be running properly
)

curl -s http://localhost:3000 >nul 2>&1
if %errorLevel% == 0 (
    echo [SUCCESS] Frontend is running on port 3000
) else (
    echo [WARNING] Frontend may not be running properly
)

echo.
echo ============================================
echo INSTALLATION COMPLETED!
echo ============================================
echo.
echo PrintShop Hub has been installed and configured to start automatically.
echo.
echo What was installed:
echo - Dependencies installed
echo - Startup script added to Windows startup folder
echo - Desktop shortcut created
echo - Uninstall script created
echo.
echo The application will start automatically when you log into Windows.
echo.
echo To start the application now: Double-click the desktop shortcut
echo Or run: %STARTUP_SCRIPT%
echo.
echo To uninstall: Run %UNINSTALL_SCRIPT%
echo.
echo Press any key to open the application in your browser...
pause >nul

:: Open browser
start http://localhost:3000

echo.
echo Installation complete! The application is now running.
echo.
pause
