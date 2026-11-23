# ============================================================
# GitMate 泳道图效果稿（IDEA 同款风格 mockup）
# 平滑贝塞尔曲线 + 泳道色稳定 + 多分支多合并 + ref 徽标 + 暗色主题
# 运行后输出：D:\GitMate\设计稿\swimlane-mockup.png
# ============================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$W = 1240; $RH = 34; $LW = 26; $TOP = 26
$bgc = [System.Drawing.Color]::FromArgb(255, 23, 25, 31)

# ---------- 数据：拓扑序（新→旧），id/主题/作者/日期/父提交们/徽标 ----------
$C = @(
  @{ id='ME'; s="Merge remote-tracking branch 'origin/tms-j1-employee' into tms-j1-employee"; a='gffish'; d='2026/11/19 19:47'; p=@('MD','e2'); merge=$true; badge='HEAD · tms-j1-employee' },
  @{ id='e2'; s='数据范围接口文档'; a='aimiu'; d='2026/11/19 22:33'; p=@('e1'); badge='origin/tms-j1-role-aimiu' },
  @{ id='e1'; s='角色接口文档设计'; a='lsj'; d='2026/11/18 22:57'; p=@('main4') },
  @{ id='MD'; s="Merge branch 'tms-j1-role-Marry.N' into tms-j1-role"; a='lsj'; d='2026/11/19 15:14'; p=@('MC','d2'); merge=$true },
  @{ id='d2'; s='新增负载字段适配系统业务需求'; a='awei'; d='2026/11/19 15:32'; p=@('d1'); badge='origin/arch-java' },
  @{ id='d1'; s='移除仓库中的settings.xml，本地保留个人配置'; a='lsj'; d='2026/11/19 15:09'; p=@('main4') },
  @{ id='MC'; s="Merge remote-tracking branch 'origin/tms-j1-role' into tms-j1-role"; a='lsj'; d='2026/11/19 15:19'; p=@('MB','c3'); merge=$true },
  @{ id='c3'; s='角色、角色-菜单权限 接口文档设计'; a='lsj'; d='2026/11/19 15:11'; p=@('c2') },
  @{ id='c2'; s='移除settings.xml版本跟踪，本地保留私有配置'; a='lsj'; d='2026/11/19 15:14'; p=@('c1') },
  @{ id='c1'; s='更新版本计划emmx'; a='lsj'; d='2026/11/19 15:13'; p=@('main3') },
  @{ id='MB'; s="Merge branch 'tms-j1-profile' into tms-j1-profile-MYFeng66"; a='Feng666Fen'; d='2026/11/19 19:28'; p=@('MA','b2'); merge=$true },
  @{ id='b2'; s='定义个人中心5个接口契约(空实现)，含Employee实体与数据层骨架'; a='Feng666Fen'; d='2026/11/19 19:10'; p=@('b1'); badge='../tms-j1-profile-jlyi' },
  @{ id='b1'; s='初步构建 tms-j1-employee 模块'; a='逆光'; d='2026/11/19 0:32'; p=@('main2') },
  @{ id='MA'; s="Merge remote-tracking branch 'origin/tms-j1-employee'"; a='逆光'; d='2026/11/19 19:28'; p=@('main4','a3'); merge=$true },
  @{ id='a3'; s='README写错了，已修改'; a='逆光'; d='2026/11/19 19:28'; p=@('a2') },
  @{ id='a2'; s='j1组织结构和接口文档定义'; a='gffish'; d='2026/11/19 20:17'; p=@('a1') },
  @{ id='a1'; s='j1组织结构和接口文档定义和接口文档'; a='gffish'; d='2026/11/19 20:02'; p=@('main3') },
  @{ id='main4'; s='新增负载字段适配系统业务需求'; a='awei'; d='2026/11/19 15:32'; p=@('main3') },
  @{ id='main3'; s='apis、domain、j1-role 的结构目录创建'; a='lsj'; d='2026/11/18 16:00'; p=@('main2') },
  @{ id='main2'; s='chore: 停止跟踪个人本地配置文件'; a='lsj'; d='2026/11/18 23:04'; p=@('main1') },
  @{ id='main1'; s='新增Java项目架构'; a='awei'; d='2026/11/10 15:25'; p=@(); badge='origin & master' }
)

# ---------- 泳道布局（与应用内 buildGraphRows 同一套算法） ----------
$palette = @('#b07cff', '#3ecf8e', '#58a6ff', '#f2a666', '#4dd4e8', '#e58ee0')
$script:cursor = 0
function Next-Color { $c = [System.Drawing.ColorTranslator]::FromHtml($palette[$script:cursor % $palette.Count]); $script:cursor++; $c }
function Cvt($html) { [System.Drawing.ColorTranslator]::FromHtml($html) }

$lanes = New-Object System.Collections.ArrayList   # @{head;color;isNew}
$rows = New-Object System.Collections.ArrayList    # @{dot;dotColor;verts=@(j);curves=@(@{from;to;color}); merge=@(@{to;color}); commit; y}
$index = @{}   # id → commit 行号

for ($i = 0; $i -lt $C.Count; $i++) {
  $c = $C[$i]
  $dotCol = -1
  for ($j = 0; $j -lt $lanes.Count; $j++) { if ($lanes[$j]['head'] -eq $c['id']) { $dotCol = $j; break } }
  if ($dotCol -eq -1) {
    $dotCol = $lanes.Count
    [void]$lanes.Add(@{ head = $c['id']; color = (Next-Color); isNew = $true })
  }
  $dotColor = $lanes[$dotCol]['color']

  $mapped = New-Object System.Collections.ArrayList
  for ($j = 0; $j -lt $lanes.Count; $j++) {
    $head = if ($j -eq $dotCol) { if ($c['p'].Count -gt 0) { $c['p'][0] } else { $null } } else { $lanes[$j]['head'] }
    $isNew = $lanes[$j]['isNew'] -and ($j -ne $dotCol)
    [void]$mapped.Add(@{ head = $head; color = $lanes[$j]['color']; isNew = $isNew })
  }
  $mapped[$dotCol]['isNew'] = $false
  $mergeEdges = @()
  for ($k = 1; $k -lt $c['p'].Count; $k++) {
    $p = $c['p'][$k]
    $col = -1
    for ($j = 0; $j -lt $mapped.Count; $j++) { if ($mapped[$j]['head'] -eq $p) { $col = $j; break } }
    if ($col -eq -1) { [void]$mapped.Add(@{ head = $p; color = (Next-Color); isNew = $true }); $col = $mapped.Count - 1 }
    if ($col -ne $dotCol) { $mergeEdges += @{ to = $col } }
  }
  if ($c['p'].Count -gt 0) {
    $p1 = $c['p'][0]
    for ($j = 0; $j -lt $mapped.Count; $j++) {
      if ($j -ne $dotCol -and $mapped[$j]['head'] -eq $p1) { $mapped[$dotCol]['head'] = $null; $mergeEdges += @{ to = $j }; break }
    }
  }

  $colMap = @{}
  $newLanes = New-Object System.Collections.ArrayList
  for ($j = 0; $j -lt $mapped.Count; $j++) {
    if ($null -eq $mapped[$j]['head']) { $colMap[$j] = -1; continue }
    $colMap[$j] = $newLanes.Count
    [void]$newLanes.Add($mapped[$j])
  }
  $lanes.Clear(); foreach ($l in $newLanes) { [void]$lanes.Add($l) }

  [void]$rows.Add(@{
    dot = $dotCol; dotColor = $dotColor
    verts = (0..($mapped.Count - 1) | ForEach-Object { @{ j = $_; m = $colMap[$_]; color = $mapped[$_]['color']; isNew = $mapped[$_]['isNew'] } })
    merge = ($mergeEdges | ForEach-Object { @{ to = $colMap[$_['to']]; color = $mapped[$_['to']]['color'] } })
    commit = $c; y = $TOP + $i * $RH
  })
  $index[$c['id']] = $i
}

# ---------- 渲染 ----------
$H = $TOP + $C.Count * $RH + 30
$bmp = New-Object System.Drawing.Bitmap(($W * 2), ($H * 2))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.ScaleTransform(2, 2)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear($bgc)

$fSub = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
$fMeta = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)
$fBadge = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
$bSub = New-Object System.Drawing.SolidBrush (Cvt '#d5d8e2')
$bDim = New-Object System.Drawing.SolidBrush (Cvt '#787d90')
$bMerge = New-Object System.Drawing.SolidBrush (Cvt '#8b8fa3')
$bBadgeText = New-Object System.Drawing.SolidBrush (Cvt '#c9b8ff')
$bBadgeBg = New-Object System.Drawing.SolidBrush ((Cvt '#7c6cff')).Color -as [System.Drawing.Brush]
$bBadgeBg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 124, 108, 255))
$penDark = New-Object System.Drawing.Pen ($bgc, 2)

foreach ($r in $rows) {
  $y = $r['y']; $mid = $y + $RH / 2
  foreach ($v in $r['verts']) {
    if ($v['isNew']) { continue }
    $x = 24 + $v['j'] * $LW + 8
    $pen = New-Object System.Drawing.Pen ($v['color'], 2)
    if ($v['m'] -eq -1) { $g.DrawLine($pen, $x, $y, $x, $mid) }
    elseif ($v['m'] -eq $v['j']) { $g.DrawLine($pen, $x, $y, $x, $y + $RH) }
    else {
      $g.DrawLine($pen, $x, $y, $x, $mid)
      $x2 = 24 + $v['m'] * $LW + 8
      $g.DrawBezier($pen, $x, $mid, $x, $mid + 10, $x2, $y + $RH - 10, $x2, $y + $RH)
    }
  }
  foreach ($e in $r['merge']) {
    $pen = New-Object System.Drawing.Pen ($e['color'], 2)
    $x1 = 24 + $r['dot'] * $LW + 8
    $x2 = 24 + $e['to'] * $LW + 8
    $g.DrawBezier($pen, $x1, $mid, $x1, $mid + 9, $x2, $y + $RH - 9, $x2, $y + $RH)
  }
}

# 文本与提交点（两遍：先画线后画点保证点在线上）
foreach ($r in $rows) {
  $y = $r['y']; $mid = $y + $RH / 2
  $c = $r['commit']
  $dotBrush = New-Object System.Drawing.SolidBrush ($r['dotColor'])
  $x = 24 + $r['dot'] * $LW + 8
  $g.FillEllipse($dotBrush, $x - 5, $mid - 5, 10, 10)
  $g.DrawEllipse($penDark, $x - 5, $mid - 5, 10, 10)

  $subjBrush = if ($c['merge']) { $bMerge } else { $bSub }
  $g.DrawString($c['s'], $fSub, $subjBrush, 210, $mid - 9)
  $g.DrawString($c['a'], $fMeta, $bDim, 800, $mid - 8)
  $g.DrawString($c['d'], $fMeta, $bDim, 960, $mid - 8)

  if ($c['badge']) {
    $t = $c['badge']
    $sz = $g.MeasureString($t, $fBadge)
    $bw = $sz.Width + 16; $bh = 18; $bx = 940 - $bw; $by = $mid - $bh / 2
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rr = 9
    [void]$gp.AddArc($bx, $by, $rr * 2, $bh, 180, 90)
    [void]$gp.AddArc($bx + $bw - $rr * 2, $by, $rr * 2, $bh, 270, 90)
    [void]$gp.AddArc($bx + $bw - $rr * 2, $by + $bh - $rr * 2, $rr * 2, $bh, 0, 90)
    [void]$gp.AddArc($bx, $by + $bh - $rr * 2, $rr * 2, $bh, 90, 90)
    $gp.CloseFigure()
    $g.FillPath($bBadgeBg, $gp)
    $g.DrawString($t, $fBadge, $bBadgeText, $bx + 8, $by + 1)
  }
}

$out = 'D:\GitMate\设计稿\swimlane-mockup.png'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "已生成: $out"
