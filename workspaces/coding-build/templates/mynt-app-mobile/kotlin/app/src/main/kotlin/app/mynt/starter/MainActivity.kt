// Runs a journey on a client session from your api (never an app key in the app). The SDK's JourneyRunner
// records the evidence and stores fields; this screen only renders steps. Customer input lives in memory
// only: nothing is written to disk, and FLAG_SECURE keeps it out of screenshots and the recents screen.
package app.mynt.starter

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import __MYNT_SDK_PACKAGE__.JourneyRunner
import __MYNT_SDK_PACKAGE__.MyntClient
import __MYNT_SDK_PACKAGE__.StepInput

// The exact text of each document the product requires, as published by the provider. Show it verbatim.
val DOCUMENT_TEXT: Map<String, String> = emptyMap()

class MainActivity : ComponentActivity() {
    private val outcome = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        setContent {
            MaterialTheme { Journey(outcome) { url -> CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(url)) } }
        }
    }

    // The hosted flow came back through myntapp://journey?outcome=...
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { outcome.value = it.getQueryParameter("outcome") ?: "completed" }
    }
}

/** POST {API_URL}/session: your api mints a client session and returns its client_secret. */
private fun mintSession(): String {
    val conn = URL(BuildConfig.API_URL.trimEnd('/') + "/session").openConnection() as HttpURLConnection
    conn.requestMethod = "POST"
    if (conn.responseCode !in 200..299) throw IllegalStateException("Couldn't start a session")
    return JSONObject(conn.inputStream.bufferedReader().use { it.readText() }).getString("client_secret")
}

@Composable
fun Journey(outcome: MutableState<String?>, openHosted: (String) -> Unit) {
    var runner by remember { mutableStateOf<JourneyRunner?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    val fields = remember { mutableStateMapOf<String, String>() } // in memory only, never persisted
    val scope = rememberCoroutineScope()

    fun run(block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
                fields.clear()
                tick++
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    LaunchedEffect(Unit) {
        try {
            runner = withContext(Dispatchers.IO) { JourneyRunner(MyntClient(mintSession(), BuildConfig.MYNT_URL), BuildConfig.JOURNEY_ID) }
        } catch (e: Exception) {
            error = e.message
        }
    }
    LaunchedEffect(outcome.value) {
        val o = outcome.value ?: return@LaunchedEffect
        outcome.value = null
        val r = runner ?: return@LaunchedEffect
        run { withContext(Dispatchers.IO) { r.complete(StepInput(outcome = o)) } }
    }

    Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val r = runner
        val step = r?.current
        key(tick) {
            when {
                error != null -> Text(error ?: "", color = MaterialTheme.colorScheme.error)
                r == null -> Text("Loading...")
                r.done || step == null -> Text("All done.")
                else -> {
                    step.optString("title").takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.titleLarge) }
                    val screen = step.optJSONArray("screen")
                    val elements = if (screen == null) emptyList() else (0 until screen.length()).map { screen.getJSONObject(it) }
                    for (e in elements) {
                        when (e.getString("type")) {
                            "text" -> Text(e.getString("text"))
                            "disclosure" -> Text(DOCUMENT_TEXT[e.getString("document")] ?: "")
                            "field" -> {
                                val name = e.getString("field")
                                val secure = e.optString("capture") == "secure_field"
                                OutlinedTextField(
                                    value = fields[name] ?: "",
                                    onValueChange = { fields[name] = it },
                                    label = { Text(name) },
                                    visualTransformation = if (secure) PasswordVisualTransformation() else VisualTransformation.None,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                    }
                    val consent = step.optString("capture_consent").takeIf { it.isNotEmpty() }?.let { "I agree to ${it.replace('_', ' ')}." }
                    consent?.let { Text(it) }
                    Button(onClick = {
                        run {
                            val documents = elements.filter { it.getString("type") == "disclosure" }
                                .associate { it.getString("document") to (DOCUMENT_TEXT[it.getString("document")] ?: "") }
                            val redirect = withContext(Dispatchers.IO) {
                                r.complete(StepInput(documents = documents, fields = fields.toMap(), consentText = consent))
                            }
                            if (redirect != null) openHosted(redirect)
                        }
                    }) { Text(if (step.has("action")) "Continue to provider" else if (consent != null) "I agree" else "Continue") }
                }
            }
        }
    }
}
