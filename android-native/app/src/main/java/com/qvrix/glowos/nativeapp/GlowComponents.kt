package com.qvrix.glowos.nativeapp

import android.content.Intent
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.*
import androidx.compose.ui.unit.*
import androidx.core.graphics.PathParser
import org.json.JSONObject

val Pink = Color(0xfff43f8e)
val PinkLight = Color(0xfffb6fb0)
val Background = Color(0xff020617)
val Panel = Color(0xff0f172a)
val Border = Color(0xff1e293b)
val Muted = Color(0xff94a3b8)
val Green = Color(0xff34d399)
val Jakarta = FontFamily(Font(R.font.plus_jakarta_sans))

@Composable fun GlowTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(primary = Pink, secondary = Green, background = Background, surface = Panel,
        onPrimary = Color.White, onBackground = Color.White, onSurface = Color.White, outline = Border),
        typography = Typography().let { t -> t.copy(bodyLarge = t.bodyLarge.copy(fontFamily = Jakarta), bodyMedium = t.bodyMedium.copy(fontFamily = Jakarta),
            labelLarge = t.labelLarge.copy(fontFamily = Jakarta), titleLarge = t.titleLarge.copy(fontFamily = Jakarta)) }, content = content)
}

@Composable fun GText(value: String, size: Int = 14, color: Color = Color.White, bold: Boolean = false, modifier: Modifier = Modifier) {
    Text(value, modifier, color, fontSize = size.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal, fontFamily = Jakarta)
}
@Composable fun GCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().background(Panel, RoundedCornerShape(24.dp)).border(1.dp, Border, RoundedCornerShape(24.dp)).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
}
@Composable fun GButton(label: String, icon: String? = null, enabled: Boolean = true, subtle: Boolean = false, onClick: () -> Unit) {
    Button(onClick, enabled = enabled, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = if (subtle) Border else Pink, contentColor = Color.White), contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp)) {
        if (icon != null) { GIcon(icon); Spacer(Modifier.width(8.dp)) }; GText(label, 12, bold = true)
    }
}
@Composable fun GField(label: String, value: String, onChange: (String) -> Unit, password: Boolean = false, lines: Int = 1) {
    var visible by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val date = label.contains("YYYY-MM-DD")
    val time = label.contains("HH:mm")
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        GText(label.uppercase(), 10, Muted, true)
        OutlinedTextField(value, onChange, Modifier.fillMaxWidth(), singleLine = lines == 1, minLines = lines,
            textStyle = LocalTextStyle.current.copy(fontFamily = Jakarta, fontSize = 14.sp), shape = RoundedCornerShape(12.dp),
            visualTransformation = if (password && !visible) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            trailingIcon = if (password) { { IconButton({ visible = !visible }) { GIcon(if (visible) "eye-off" else "eye", Muted) } } }
                else if (date || time) { { IconButton({
                    val current = java.util.Calendar.getInstance()
                    if (date) {
                        runCatching { current.time = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).parse(value)!! }
                        android.app.DatePickerDialog(context, { _, year, month, day -> onChange("%04d-%02d-%02d".format(java.util.Locale.US, year, month + 1, day)) }, current.get(java.util.Calendar.YEAR), current.get(java.util.Calendar.MONTH), current.get(java.util.Calendar.DAY_OF_MONTH)).show()
                    } else {
                        val minutes = runCatching { com.qvrix.glowos.nativeapp.online.BusinessRules.minute(value) }.getOrDefault(current.get(java.util.Calendar.HOUR_OF_DAY) * 60 + current.get(java.util.Calendar.MINUTE))
                        android.app.TimePickerDialog(context, { _, hour, minute -> onChange("%02d:%02d".format(java.util.Locale.US, hour, minute)) }, minutes / 60, minutes % 60, true).show()
                    }
                }) { GIcon(if (date) "calendar" else "clock", Muted) } } } else null,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = when {
                password -> androidx.compose.ui.text.input.KeyboardType.Password
                label.contains("phone", true) -> androidx.compose.ui.text.input.KeyboardType.Phone
                label.contains("email", true) -> androidx.compose.ui.text.input.KeyboardType.Email
                label.contains("price", true) || label.contains("₹") -> androidx.compose.ui.text.input.KeyboardType.Decimal
                else -> androidx.compose.ui.text.input.KeyboardType.Text
            }),
            colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Border, focusedBorderColor = Pink, unfocusedContainerColor = Background, focusedContainerColor = Background))
    }
}
@Composable fun GSelect(label: String, value: String, choices: List<Pair<String, String>>, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        GText(label.uppercase(), 10, Muted, true)
        Box {
            Row(Modifier.fillMaxWidth().padding(top = 5.dp).background(Background, RoundedCornerShape(12.dp)).border(1.dp, Border, RoundedCornerShape(12.dp)).clickable { expanded = true }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                GText(choices.find { it.first == value }?.second ?: value.ifBlank { "Select $label" }, modifier = Modifier.weight(1f)); GIcon("chevron-down")
            }
            DropdownMenu(expanded, { expanded = false }) { choices.forEach { (key, title) -> DropdownMenuItem(text = { GText(title) }, onClick = { onChange(key); expanded = false }) } }
        }
    }
}
@Composable fun GSwitch(label: String, value: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { GText(label, modifier = Modifier.weight(1f)); Switch(value, change) }
}
@Composable fun GDialog(title: String, dismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    androidx.compose.ui.window.Dialog(dismiss, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxWidth().padding(16.dp).widthIn(max = 700.dp).heightIn(max = 760.dp).background(Panel, RoundedCornerShape(24.dp)).border(1.dp, Border, RoundedCornerShape(24.dp)).padding(20.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { GText(title, 20, bold = true, modifier = Modifier.weight(1f)); IconButton(dismiss) { GIcon("x") } }
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp), content = content)
        }
    }
}
@Composable fun GIcon(name: String, color: Color = Color.White, size: Int = 18) {
    val context = LocalContext.current
    val catalog = remember { JSONObject(context.assets.open("lucide.json").bufferedReader().use { it.readText() }) }
    val nodes = remember(name) { catalog.optJSONArray(name) }
    Canvas(Modifier.size(size.dp)) {
        scale(this.size.width / 24f, this.size.height / 24f, Offset.Zero) {
            val stroke = Stroke(2f, cap = StrokeCap.Round, join = StrokeJoin.Round)
            if (nodes != null) for (i in 0 until nodes.length()) {
                val node = nodes.getJSONArray(i); val attrs = node.getJSONObject(1)
                fun n(key: String) = attrs.optString(key).toFloatOrNull() ?: 0f
                when (node.getString(0)) {
                    "path" -> runCatching { drawPath(PathParser.createPathFromPathData(attrs.getString("d")).asComposePath(), color, style = stroke) }
                    "line" -> drawLine(color, Offset(n("x1"), n("y1")), Offset(n("x2"), n("y2")), 2f, StrokeCap.Round)
                    "circle" -> drawCircle(color, n("r"), Offset(n("cx"), n("cy")), style = stroke)
                    "rect" -> drawRoundRect(color, Offset(n("x"), n("y")), Size(n("width"), n("height")), CornerRadius(n("rx")), style = stroke)
                    "polyline", "polygon" -> {
                        val points = attrs.getString("points").split(Regex("[ ,]+")).mapNotNull { it.toFloatOrNull() }
                        val p = Path(); points.chunked(2).filter { it.size == 2 }.forEachIndexed { index, a -> if (index == 0) p.moveTo(a[0], a[1]) else p.lineTo(a[0], a[1]) }; if (node.getString(0) == "polygon") p.close(); drawPath(p, color, style = stroke)
                    }
                }
            }
        }
    }
}

fun android.content.Context.share(text: String) { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text) }, "Share")) }
fun android.content.Context.copy(text: String) { (getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("Qvrix GlowOS", text)) }
