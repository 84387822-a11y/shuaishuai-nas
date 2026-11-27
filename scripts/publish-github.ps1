<#
  一键发布到 GitHub：
    1) 把当前目录提交并推送到 master
    2) 用 gh 创建 Release（附带 x86 / arm 安装包与发布说明）

  前置条件（任选其一）：
    - 已执行 gh auth login
    - 或设置环境变量 GH_TOKEN（具有 repo 权限的 Personal Access Token）

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\publish-github.ps1 -Version 1.0.4
#>

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Owner = '84387822-a11y',
  [string]$Repo = 'shuaishuai-nas',
  [string]$Branch = 'master'
)

$ErrorActionPreference = 'Stop'

$git = 'C:\Program Files\Git\cmd\git.exe'
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
if (-not (Test-Path $git)) { $git = 'git' }
if (-not (Test-Path $gh)) { $gh = 'gh' }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$fpkX86 = Join-Path $root "dist\shuaishuai_${Version}_x86.fpk"
$fpkArm = Join-Path $root "dist\shuaishuai_${Version}_arm.fpk"
$notes = Join-Path $root "docs\RELEASE-${Version}.md"

foreach ($f in @($fpkX86, $notes)) {
  if (-not (Test-Path $f)) { throw "缺少文件：$f（请先运行 npm run build:fpk）" }
}

Write-Host '[1/4] 检查 GitHub 登录状态…'
& $gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw '未登录 GitHub：请先执行 gh auth login，或设置 GH_TOKEN 环境变量' }

Write-Host '[2/4] 提交并推送代码…'
if (-not (& $git remote)) {
  & $git remote add origin "https://github.com/$Owner/$Repo.git"
}
& $git add -A
& $git -c user.name='NAS助手' -c user.email='noreply@users.noreply.github.com' commit -m "release: v$Version" 2>$null
& $git push -u origin $Branch

Write-Host '[3/4] 创建 Release…'
$assets = @($fpkX86)
if (Test-Path $fpkArm) { $assets += $fpkArm }
& $gh release create "v$Version" @assets --title "NAS助手 v$Version" --notes-file $notes --repo "$Owner/$Repo"

Write-Host "[4/4] 完成：https://github.com/$Owner/$Repo/releases/tag/v$Version"
