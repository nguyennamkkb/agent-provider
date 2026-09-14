# get_api_detail LazyVGrid — output SAU CLEAN

> members gọn (top 20, gọn nhẹ, lọc _internal), memberCount tổng. So với bản trước: bỏ _makeView, bỏ availability lặp, bỏ framework/lang/parent lặp trong từng member.

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
      "introducedIn": 140000
    }
  ],
  "memberCount": 2
}
```
