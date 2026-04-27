param(
    [Parameter(Mandatory=$true)] [string]$BotPath
)

# Registers the AlpacaBot task with two triggers:
#   1. At boot          - bot + API + dashboard auto-restore after reboot
#   2. Weekdays 06:25   - pre-open health check; IgnoreNew makes it a no-op
#                          when the bot is already alive
#
# Uses Register-ScheduledTask rather than schtasks.exe because the older CLI
# can't add multiple triggers in one call.

$TaskName = 'AlpacaBot'

$action = New-ScheduledTaskAction -Execute $BotPath

$trigBoot   = New-ScheduledTaskTrigger -AtStartup
$trigDaily  = New-ScheduledTaskTrigger -Weekly -At '06:25' `
              -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -WakeToRun `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# Use the current user's identity at HIGHEST run level so wake-to-run works.
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

# Replace any existing task. -Force avoids "task already exists" errors.
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($trigBoot, $trigDaily) `
    -Settings $settings `
    -Principal $principal `
    -Description 'Alpaca paper bot + API + dashboard (24/7)' `
    -Force | Out-Null

Write-Host ''
Write-Host ('Registered: ' + $TaskName + ' with two triggers')
Write-Host '  - At PC boot (auto-start after reboot, even if PC was sleeping)'
Write-Host '  - Weekdays 06:25 local time (pre-open health check)'
Write-Host ('Stop with:  schtasks /Delete /TN ' + $TaskName + ' /F')

# Show what we just registered.
Write-Host ''
Write-Host '=== Triggers ==='
Get-ScheduledTask -TaskName $TaskName |
    Select-Object -ExpandProperty Triggers |
    ForEach-Object {
        $kind = $_.CimClass.CimClassName
        Write-Host ('  ' + $kind + ': ' + (($_ | Format-List | Out-String).Trim() -replace "`r`n", '; '))
    }
