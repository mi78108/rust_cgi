<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>@<{print(title)}></title>
<style>
  body{font-family:ui-monospace,Menlo,monospace;background:#f4f1de;color:#0f0f12;padding:28px}
  h1{font-size:18px;margin:0 0 16px}
  table{border-collapse:collapse;width:100%;max-width:520px}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #ccc}
  th{font-weight:600;background:#ecead7}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .foot{margin-top:18px;font-size:12px;color:#666}
</style>
</head>
<body>

<h1>@<{print(title)}></h1>

<table>
  <tr><th>name</th><th>lang</th><th class="num">commits</th></tr>
@<{
    for u in items:
        print(
            "<tr>"
            f"<td>{u['name']}</td>"
            f"<td>{u['lang']}</td>"
            f"<td class=\"num\">{u['commits']}</td>"
            "</tr>"
        )
}>
</table>

<p class="foot">共 @<{print(len(items))}> 条 · 模板来自 <code>page.tpl</code></p>
<p class="foot">洞内可以写 {} 块和 f-string, 只要别出现 <code>}&gt;</code></p>

</body>
</html>