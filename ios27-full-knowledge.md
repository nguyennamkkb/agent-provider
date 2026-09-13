# Toàn bộ tri thức iOS 27 từ Xcode 27.0 (27A266a)

> Nguồn: iPhoneOS.sdk 27.0 + 20 file AdditionalDocumentation + swiftinterface + ObjC headers
> Ngày trích xuất: 2026-09-13

---

## I. TỔNG QUAN

- **1,101 API declarations** mới `@available(iOS 27.0)` trong **66 frameworks**
- **25+ framework mới/được mở rộng đáng kể**
- **20 file documentation** embedded trong Xcode (AI AdditionalDocumentation)

---

## II. FRAMEWORKS MỚI HOÀN TOÀN (iOS 27+)

### 1. FoundationModels.framework — **241 API declarations (nhiều nhất)**
- On-device LLM cho Apple Intelligence
- `LanguageModelSession`, `SystemLanguageModel`, `Instructions`, `Prompt`
- `Tool` protocol — model gọi tool trong app
- `Generable` macro — generate Swift structs từ model
- `GenerationSchema`, `DynamicGenerationSchema` — guided generation
- `DynamicProfile`, `DynamicInstructions` — compose dynamic context
- `PrivateCloudComputeLanguageModel` — server-side intelligence
- `Transcript` — session history
- Multimodal: `Attachment`, `ImageAttachmentContent`
- Platform: iOS 26.0+ (base), iOS 27.0+ (PrivateCloudCompute)

### 2. AlarmKit.framework
- Custom alarms & timers trong app
- `AlarmManager.shared`, `Alarm` struct, `Schedule`
- Countdown timers, snooze functionality
- Alarm authorization, UI templated + widget
- Live Activities + Dynamic Island integration
- Override device focus/silent mode

### 3. AudioAccessoryKit.framework — **13 declarations**
- Audio accessory management APIs
- `AudioAccessory` types, connection management

### 4. BrowserEngineKit.framework — **4 declarations**
- Web browser engine integration

### 5. PaperKit.framework — **32 declarations**
- Document/annotation APIs
- Paper-like interactions, handwriting

### 6. MediaDevice.framework — **24 declarations**
- Media device discovery and management

### 7. MediaIntelligence.framework — **12 declarations**
- Media analysis and intelligence APIs

### 8. ProximityReader.framework — **36 declarations**
- NFC/proximity reading capabilities

### 9. NowPlaying.framework — **49 declarations**
- Now Playing info, controls, integration

### 10. MusicUnderstanding.framework — **31 declarations**
- Music analysis and understanding APIs

### 11. TrustInsights.framework — **29 declarations**
- Trust and insights data

### 12. StateReporting.framework — **7 declarations**
- Device state reporting APIs

### 13. ImagePlayground.framework — **8 declarations**
- Image generation/playground APIs

### 14. ManagedAppDistribution.framework
- Enterprise app distribution

### 15. AppManagedFeatures.framework — **10 declarations**
- App-managed feature flags/configuration

### 16. EnergyKit.framework — **11 declarations**
- Energy usage data and reporting

### 17. Assignables.framework
- Assignment/role-based APIs

### 18. MediaIntents.framework
- Media playback intents

### 19. TelephonyMessagingKit.framework — **22 declarations**
- Telephony/messaging integration

### 20. SecureElementCredential.framework
- Secure element credential management

### 21. AccessoryTransportExtension.framework — **4 declarations**
- Accessory transport extensions

### 22. AccessoryLiveActivities.framework
- Accessory live activities

### 23. AccessoryNotifications.framework
- Accessory notification system

### 24. AccessorySetupKit.framework
- Accessory setup workflow

---

## III. FRAMEWORKS MỚI API iOS 27 (trên framework cũ)

### SwiftUI.framework — **124 declarations**
- Liquid Glass design system
- New toolbar features
- Styled text editing
- WebKit integration

### MetricKit.framework — **102 declarations**
- Massive expansion of metrics/diagnostics API
- New metric types, diagnostic payloads

### SensorKit.framework — **54 declarations**
- Sensor data access and reporting

### AppIntents.framework — **28 declarations**
- Visual Intelligence integration
- Onscreen entities, intent modes
- Multiple Choice API
- @ComputedProperty, @DeferredProperty macros
- Interactive snippets

### UIKit.framework — **17 declarations**
- Liquid Glass support
- New view controller APIs
- Updated rendering pipeline

### SwiftUICore.framework — **22 declarations**
- Core SwiftUI engine updates

### PencilKit.framework — **20 declarations**
- Pencil/stylus interaction updates

### CryptoKit.framework — **20 declarations**
- New cryptographic algorithms

### AVSystemRouting.framework — **18 declarations**
- Audio routing management

### DataDetection.framework — **16 declarations**
- Data detection and extraction

### BackgroundAssets.framework — **16 declarations**
- Background asset management

### StoreKit.framework — **13 declarations**
- AppTransaction new fields
- Transaction.currentEntitlements(for:)
- RenewalInfo enhancements
- SubscriptionOfferView
- JWS signing, Advanced Commerce API

### NetworkExtension.framework — **10 declarations**
- Network extension updates

### PhotosUI.framework — **8 declarations**
- Photo UI integration updates

### AVKit.framework — **8 declarations**
- AVKit updates

### AVFAudio.framework — **5 declarations**
- AVAudioSession new notifications
- Realtime-safe audio node APIs
- Outdoor reverb preset

---

## IV. 20 FILE DOCUMENTATION (Xcode AdditionalDocumentation)

### Nhóm 1: AI & Machine Learning
1. **FoundationModels-Using-on-device-LLM-in-your-app.md** (339 dòng)
   - SystemLanguageModel availability check
   - LanguageModelSession creation
   - Instructions vs Prompts
   - Tool calling
   - Generable macro for structured output
   - Private Cloud Compute fallback

### Nhóm 2: Liquid Glass Design (4 files)
2. **SwiftUI-Implementing-Liquid-Glass-Design.md** (280 dòng)
   - `.glassEffect()` modifier
   - Shape customization: `.capsule`, `.rect`, `.circle`
   - Glass variants: `.regular`, `.tint()`, `.interactive()`
   - Morphing transitions

3. **UIKit-Implementing-Liquid-Glass-Design.md** (281 dòng)
   - UIKit equivalent of Liquid Glass
   - UIViewController/UIView integration

4. **AppKit-Implementing-Liquid-Glass-Design.md** (370 dòng)
   - macOS Liquid Glass implementation

5. **WidgetKit-Implementing-Liquid-Glass-Design.md** (234 dòng)
   - Widget rendering modes: full color vs accented
   - `widgetRenderingMode` environment
   - Tinted/clear Home Screen support

### Nhóm 3: Swift Language (3 files)
6. **Swift-Concurrency-Updates.md** (273 dòng)
   - Swift 6.2 "Approachable Concurrency"
   - Default actor isolation (single-threaded by default)
   - `nonisolated(nonsending)` functions
   - Data-race safety improvements

7. **Swift-InlineArray-Span.md** (289 dòng)
   - `InlineArray<N, Element>` — fixed-size inline storage
   - `Span<T>`, `MutableSpan<T>` — safe contiguous memory
   - Performance vs Array and UnsafeBufferPointer

8. **Swift-Charts-3D-Visualization.md** (375 dòng)
   - `Chart3D` view container
   - `SurfacePlot` for 3D data
   - `Chart3DPose` for camera angle
   - `Chart3DSurfaceStyle` for appearance

### Nhóm 4: UI & Design (4 files)
9. **SwiftUI-Styled-Text-Editing.md** (406 dòng)
   - Rich text editing in SwiftUI
   - AttributedString formatting
   - TextEditor customization
   - Markdown support

10. **SwiftUI-New-Toolbar-Features.md** (201 dòng)
    - Customizable toolbars
    - Toolbar spacers
    - Search toolbar behavior
    - Large subtitle placement

11. **SwiftUI-WebKit-Integration.md** (480 dòng)
    - WKWebView in SwiftUI
    - Navigation delegation
    - JavaScript bridge

12. **Foundation-AttributedString-Updates.md** (234 dòng)
    - TextAlignment, WritingDirection, LineHeight
    - replaceSelection API
    - DiscontiguousAttributedSubstring

### Nhóm 5: Data & Persistence (1 file)
13. **SwiftData-Class-Inheritance.md** (300 dòng)
    - @Model base class/subclass
    - Type-based querying with #Predicate
    - Polymorphic relationships

### Nhóm 6: System Integration (5 files)
14. **AppIntents-Updates.md** (426 dòng)
    - Visual Intelligence integration
    - Onscreen entities
    - @ComputedProperty, @DeferredProperty
    - Interactive snippets
    - Spotlight integration

15. **StoreKit-Updates.md** (277 dòng)
    - AppTransaction new fields
    - Transaction.currentEntitlements(for:)
    - SubscriptionOfferView
    - JWS signing

16. **MapKit-GeoToolbox-PlaceDescriptors.md** (308 dòng)
    - PlaceDescriptor creation
    - PlaceRepresentation
    - Service identifiers

17. **Implementing-Assistive-Access-in-iOS.md** (225 dòng)
    - Assistive Access scene
    - Plist keys
    - Runtime detection
    - Accessibility design

18. **Implementing-Visual-Intelligence-in-iOS.md** (330 dòng)
    - SemanticContentDescriptor
    - IntentValueQuery
    - Visual search integration

19. **Widgets-for-visionOS.md** (247 dòng)
    - Mounting styles, textures
    - Proximity awareness
    - Widget families

---

## V. SDK HEADERS — iOS 27 APIs ObjC

### Kernel/System (ios 27.0)
- `fchflagsat()` — file flag setting (sys/stat.h)
- `getumask()` — get file mode creation mask (sys/unistd.h)
- New compression: `COMPRESSION_LZRAVEN`, `COMPRESSION_LZMESH`
- SQLite new APIs (sqlite3.h)
- Lockdown mode updates (os/lockdown_mode.h)
- ObjC runtime updates (objc/runtime.h)

### AVFAudio (ios 27.0)
- `AVAudioSessionDidBecomeActiveNotification`
- `AVAudioSessionDidBecomeInactiveNotification`
- `AVAudioSessionResumptionRecommendationNotification`
- `AVAudioSessionDeactivationContext`
- Realtime-safe audio node APIs
- `AVAudioUnitReverbPresetOutdoorGeneral`

### ARKit (ios 27.0)
- `projectionMatrixForViewRotationAngle:viewportSize:zNear:zFar:`
- `projectPoint:viewRotationAngle:viewportSize:`
- `viewMatrixForViewRotationAngle:`
- `viewLayer` property on ARSession
- `viewRotationAngle` delegate method
- `isTracked` on ARObjectAnchor

---

## VI. THỐNG KÊ

| Metric | Value |
|--------|-------|
| Total iOS 27 API declarations (Swift) | 1,101 |
| Frameworks with iOS 27 APIs | 66 |
| New/embedded framework files | 25+ |
| Documentation files (AdditionalDocumentation) | 20 |
| Total documentation lines | ~6,636 |
| ObjC header iOS 27 declarations | 50+ |
| Top framework by API count | FoundationModels (241) |

---

## VII. CÁCH TRUY CẬP

### Đọc AdditionalDocumentation
```bash
cat /Applications/Xcode.app/Contents/PlugIns/IDEIntelligenceChat.framework/\
  Versions/A/Resources/AdditionalDocumentation/<filename>.md
```

### Đọc Swift API signature
```bash
cat /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/\
  Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks/<Framework>.framework/\
  Modules/<Framework>.swiftmodule/arm64e-apple-ios.swiftinterface
```

### Grep iOS 27 APIs
```bash
grep -rn "@available(iOS 27" /Applications/Xcode.app/Contents/Developer/\
  Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks/
```

### Đọc ObjC header
```bash
cat /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/\
  Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks/<Framework>.framework/\
  Headers/<Header>.h
```
