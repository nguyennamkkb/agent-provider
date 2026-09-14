# get_api_detail — output sau clean (member có availability RIÊNG mới hiện)

> Quy tắc đã verify trên SDK thật: member nào availability **giống cha** thì lược (giữ introducedIn là đủ); member nào **riêng** thì giữ nguyên chuỗi availability. VD GridItem (iOS 14) có member == (iOS 26) → giữ; còn init/alignment/size/spacing → lược.

## 1. GridItem (có member availability riêng)

**Request:**

```json
{
  "name": "GridItem",
  "framework": "SwiftUI"
}
```

**Output:**

```json
{
  "name": "GridItem",
  "kind": "struct",
  "framework": "SwiftUI",
  "module": "SwiftUI",
  "lang": "swift",
  "signature": "public struct GridItem : Swift.Sendable",
  "availability": "iOS 14.0, macOS 11.0, tvOS 14.0, watchOS 7.0, *",
  "minIOSVersion": 140000,
  "introducedIn": 140000,
  "deprecatedIn": null,
  "obsoletedIn": null,
  "unavailable": false,
  "deprecated": false,
  "filePath": "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks/SwiftUI.framework/Modules/SwiftUI.swiftmodule/arm64e-apple-ios.swiftinterface",
  "lineNumber": 23551,
  "members": [
    {
      "name": "init",
      "kind": "init",
      "signature": "public init(_ size: SwiftUI.GridItem.Size = .flexible(), spacing: CoreFoundation.CGFloat? = nil, alignment: SwiftUICore.Alignment? = nil)",
      "introducedIn": 140000
    },
    {
      "name": "==",
      "kind": "operator",
      "signature": "public static func == (a: SwiftUI.GridItem, b: SwiftUI.GridItem) -> Swift.Bool",
      "availability": "iOS 26.0, macOS 26.0, tvOS 26.0, visionOS 26.0, watchOS 26.0, *",
      "introducedIn": 260000
    },
    {
      "name": "alignment",
      "kind": "var",
      "signature": "public var alignment: SwiftUICore.Alignment?",
      "introducedIn": 140000
    },
    {
      "name": "size",
      "kind": "var",
      "signature": "public var size: SwiftUI.GridItem.Size",
      "introducedIn": 140000
    },
    {
      "name": "spacing",
      "kind": "var",
      "signature": "public var spacing: CoreFoundation.CGFloat?",
      "introducedIn": 140000
    }
  ],
  "memberCount": 5
}
```

---

## 2. LazyVGrid (members đều giống cha → gọn)

**Request:**

```json
{
  "name": "LazyVGrid"
}
```

**Output:**

```json
{
  "name": "LazyVGrid",
  "kind": "struct",
  "framework": "SwiftUI",
  "module": "SwiftUI",
  "lang": "swift",
  "signature": "public struct LazyVGrid<Content> : SwiftUICore.View where Content : SwiftUICore.View",
  "availability": "iOS 14.0, macOS 11.0, tvOS 14.0, watchOS 7.0, *",
  "minIOSVersion": 140000,
  "introducedIn": 140000,
  "deprecatedIn": null,
  "obsoletedIn": null,
  "unavailable": false,
  "deprecated": false,
  "filePath": "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks/SwiftUI.framework/Modules/SwiftUI.swiftmodule/arm64e-apple-ios.swiftinterface",
  "lineNumber": 23585,
  "members": [
    {
      "name": "init",
      "kind": "init",
      "signature": "public init(columns: [SwiftUI.GridItem], alignment: SwiftUICore.HorizontalAlignment = .center, spacing: CoreFoundation.CGFloat? = nil, pinnedViews: SwiftUICore.PinnedScrollableViews = .init(), @SwiftUICore.ViewBuilder content: () -> Content)",
      "introducedIn": 140000
    },
    {
      "name": "Body",
      "kind": "typealias",
      "signature": "public typealias Body = Swift.Never",
      "availability": "iOS 14.0, tvOS 14.0, watchOS 7.0, macOS 11.0, *",
      "introducedIn": 140000
    }
  ],
  "memberCount": 2
}
```
