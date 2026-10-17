//
//  ViewController.swift
//  Shared (App)
//
//  Created by blackbox on 16.10.26.
//

import WebKit

#if os(iOS)
import UIKit
import SafariServices
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
    // Diktieren / Sprache
    "com.electron.wispr-flow",              // Wispr Flow
    "com.superduper.superwhisper",          // Superwhisper
    "com.goodsnooze.MacWhisper",            // MacWhisper
    "com.prakashjoshipax.VoiceInk",         // VoiceInk
    "com.aquavoice.mac",                    // Aqua Voice
    // Automatisierung / Eingabe
    "com.hegenberg.BetterTouchTool",        // BetterTouchTool
    "com.stairways.keyboardmaestro.engine", // Keyboard Maestro
    "org.hammerspoon.Hammerspoon",          // Hammerspoon
    "com.superultra.Homerow",               // Homerow
    "com.sproutcube.Shortcat",              // Shortcat
    "com.pilotmoon.popclip",                // PopClip
    "com.logi.optionsplus",                 // Logi Options+
    "com.logitech.manager.daemon",          // Logitech Options
    // Fenster / Menüleiste / Overlays
    "com.knollsoft.Rectangle",              // Rectangle
    "com.knollsoft.Hookshot",               // Hookshot
    "com.crowdcafe.windowmagnet",           // Magnet
    "com.manytricks.Moom",                  // Moom
    "com.hegenberg.BetterSnapTool",         // BetterSnapTool
    "com.surteesstudios.Bartender",         // Bartender
    "com.jordanbaird.Ice",                  // Ice
    "com.grammarly.ProjectLlama",           // Grammarly
    "com.loom.desktop",                     // Loom
    "com.presentify.Presentify",            // Presentify
    // Fernwartung / Bildschirmfreigabe
    "com.teamviewer.TeamViewer",            // TeamViewer
    "com.philandro.anydesk",                // AnyDesk
    "com.splashtop.Splashtop-Streamer",     // Splashtop
    "com.carriez.rustdesk",                 // RustDesk
    "tv.parsec.www",                        // Parsec
    "com.p5sys.jump.connect",               // Jump Desktop Connect
]
#endif

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = true   // Inhalt ist auf kleinen iPhones hoeher als der Bildschirm
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

#if os(iOS)
    func openSettingsApp() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
#endif

#if os(macOS)
    // Fensterhoehe an den Inhalt anpassen, aber nie hoeher als der sichtbare Bildschirm
    func fitWindow(toContentHeight height: CGFloat) {
        guard let window = view.window else { return }
        let maxHeight = (window.screen ?? NSScreen.main)?.visibleFrame.height ?? 800
        let target = min(ceil(height), maxHeight - 40)
        let newFrame = window.frameRect(forContentRect: NSRect(origin: .zero, size: NSSize(width: window.contentLayoutRect.width, height: target)))
        var frame = window.frame
        frame.origin.y += frame.height - newFrame.height   // obere Kante bleibt stehen
        frame.size = newFrame.size
        window.setFrame(frame, display: true, animate: false)
        if let screen = window.screen?.visibleFrame, frame.minY < screen.minY || frame.maxY > screen.maxY { window.center() }
    }

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
#if os(iOS)
        let body = message.body as? String ?? ""
        if body == "open-ios-settings" {
            // iOS 26.2+: direkt zu Safari → Erweiterungen (gezielt Fahrtrichtung); sonst Einstellungen-App
            if #available(iOS 26.2, *) {
                SFSafariSettings.openExtensionsSettings(forIdentifiers: [extensionBundleIdentifier]) { error in
                    if error != nil { self.openSettingsApp() }
                }
            } else {
                openSettingsApp()
            }
        } else if body == "open-bahn" {
            // Gezielt Safari oeffnen (die Erweiterung laeuft nur dort), auch wenn ein anderer
            // Standardbrowser eingestellt ist; Rueckfall: normaler Link
            let safari = URL(string: "x-safari-https://www.bahn.de/")!
            UIApplication.shared.open(safari) { ok in
                if !ok { UIApplication.shared.open(URL(string: "https://www.bahn.de/")!) }
            }
        }
#endif
#if os(macOS)
        let body = message.body as? String ?? ""
        if body.hasPrefix("height:"), let h = Double(body.dropFirst(7)) {
            fitWindow(toContentHeight: CGFloat(h))
            return
        }
        if body != "open-preferences" {
            return
        }

        // Nur die Safari-Einstellungen oeffnen; das Fenster bleibt offen und zeigt danach den neuen Status
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
#endif
    }

}
