//
//  ViewController.swift
//  Shared (App)
//
//  Created by blackbox on 16.10.26.
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "info.fahrtrichtung.app.Extension"

#if os(macOS)
// Apps, die über anderen Fenstern liegen oder Eingaben simulieren. Solange eine davon
// läuft, verweigert Safari das Einschalten von Erweiterungen ("Safari hat Apps oder
// Dienste erkannt, durch die Klicks verhindert wurden"). Liste ist nicht vollständig —
// die Begleit-App zeigt zusätzlich immer einen allgemeinen Hinweis.
let clickBlockingApps: Set<String> = [
    "com.electron.wispr-flow",            // Wispr Flow
    "com.superduper.superwhisper",        // Superwhisper
    "com.goodsnooze.MacWhisper",          // MacWhisper
    "com.hegenberg.BetterTouchTool",      // BetterTouchTool
    "com.stairways.keyboardmaestro.engine", // Keyboard Maestro
    "org.hammerspoon.Hammerspoon",        // Hammerspoon
    "com.knollsoft.Rectangle",            // Rectangle
    "com.crowdcafe.windowmagnet",         // Magnet
    "com.surteesstudios.Bartender",       // Bartender
    "com.pilotmoon.popclip",              // PopClip
    "com.superultra.Homerow",             // Homerow
    "com.grammarly.ProjectLlama",         // Grammarly
    "com.logi.optionsplus",               // Logi Options+
    "com.teamviewer.TeamViewer",          // TeamViewer
    "com.philandro.anydesk",              // AnyDesk
]
#endif

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = false
#endif

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        webView.evaluateJavaScript("show('mac')")
        refreshState()
        // Status neu pruefen, wenn man aus den Safari-Einstellungen zurueckkommt
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refreshState()
        }
        // ... und sobald eine störende App beendet wird
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refreshState()
        }
#endif
    }

#if os(macOS)
    func refreshState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else { return }
            DispatchQueue.main.async {
                let blockers = NSWorkspace.shared.runningApplications
                    .filter { clickBlockingApps.contains($0.bundleIdentifier ?? "") }
                    .compactMap { $0.localizedName }
                let json = (try? JSONSerialization.data(withJSONObject: Array(Set(blockers)).sorted()))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                self.webView.evaluateJavaScript("show('mac', \(state.isEnabled), \(json))")
            }
        }
    }
#endif

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
#if os(macOS)
        if (message.body as! String != "open-preferences") {
            return
        }

        // Nur die Safari-Einstellungen oeffnen; das Fenster bleibt offen und zeigt danach den neuen Status
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
#endif
    }

}
