import ActivityKit
import ExpoModulesCore

public class ExpoLiveActivityModule: Module {
  struct LiveActivityState: Record {
    @Field
    var title: String

    @Field
    var subtitle: String?

    @Field
    var source: String?

    @Field
    var lyricsMode: String?

    @Field
    var currentLineText: String?

    @Field
    var lineStartMs: Double?

    @Field
    var lineEndMs: Double?

    @Field
    var playbackAnchorMs: Double?

    @Field
    var playbackAnchorEpochMs: Double?

    @Field
    var isPlayingLive: Bool?

    @Field
    var syllablePayload: String?

    @Field
    var progressBar: ProgressBar?

    struct ProgressBar: Record {
      @Field
      var date: Double?

      @Field
      var progress: Double?
    }

    @Field
    var imageName: String?

    @Field
    var dynamicIslandImageName: String?
  }

  struct LiveActivityConfig: Record {
    @Field
    var backgroundColor: String?

    @Field
    var titleColor: String?

    @Field
    var subtitleColor: String?

    @Field
    var progressViewTint: String?

    @Field
    var progressViewLabelColor: String?

    @Field
    var deepLinkUrl: String?

    @Field
    var timerType: DynamicIslandTimerType?

    @Field
    var padding: Int?

    @Field
    var paddingDetails: PaddingDetails?

    @Field
    var imagePosition: String?

    @Field
    var imageWidth: Int?

    @Field
    var imageHeight: Int?

    @Field
    var imageWidthPercent: Double?

    @Field
    var imageHeightPercent: Double?

    @Field
    var imageAlign: String?

    @Field
    var contentFit: String?

    struct PaddingDetails: Record {
      @Field var top: Int?
      @Field var bottom: Int?
      @Field var left: Int?
      @Field var right: Int?
      @Field var vertical: Int?
      @Field var horizontal: Int?
    }
  }

  enum DynamicIslandTimerType: String, Enumerable {
    case circular
    case digital
  }

  @available(iOS 16.1, *)
  private func sendPushToken(activity: Activity<LiveActivityAttributes>, activityPushToken: String) {
    sendEvent(
      "onTokenReceived",
      [
        "activityID": activity.id,
        "activityName": activity.attributes.name,
        "activityPushToken": activityPushToken,
      ]
    )
  }

  private func sendPushToStartToken(activityPushToStartToken: String) {
    sendEvent(
      "onPushToStartTokenReceived",
      [
        "activityPushToStartToken": activityPushToStartToken,
      ]
    )
  }

  @available(iOS 16.1, *)
  private func sendStateChange(
    activity: Activity<LiveActivityAttributes>, activityState: ActivityState
  ) {
    sendEvent(
      "onStateChange",
      [
        "activityID": activity.id,
        "activityName": activity.attributes.name,
        "activityState": String(describing: activityState),
      ]
    )
  }

  private func makeContentState(from state: LiveActivityState) -> LiveActivityAttributes.ContentState {
    LiveActivityAttributes.ContentState(
      title: state.title,
      subtitle: state.subtitle,
      source: state.source,
      lyricsMode: state.lyricsMode,
      currentLineText: state.currentLineText,
      lineStartMs: state.lineStartMs,
      lineEndMs: state.lineEndMs,
      playbackAnchorMs: state.playbackAnchorMs,
      playbackAnchorEpochMs: state.playbackAnchorEpochMs,
      isPlayingLive: state.isPlayingLive,
      syllablePayload: state.syllablePayload,
      timerEndDateInMilliseconds: state.progressBar?.date,
      progress: state.progressBar?.progress,
      imageName: state.imageName,
      dynamicIslandImageName: state.dynamicIslandImageName
    )
  }

  private func updateImages(
    state: LiveActivityState, newState: inout LiveActivityAttributes.ContentState
  ) async throws {
    if let name = state.imageName {
      newState.imageName = try await resolveImage(from: name)
    }

    if let name = state.dynamicIslandImageName {
      newState.dynamicIslandImageName = try await resolveImage(from: name)
    }
  }

  private func observePushToStartToken() {
    guard #available(iOS 17.2, *), ActivityAuthorizationInfo().areActivitiesEnabled else { return }

    print("Observing push to start token updates...")
    Task {
      for await data in Activity<LiveActivityAttributes>.pushToStartTokenUpdates {
        let token = data.reduce("") { $0 + String(format: "%02x", $1) }
        sendPushToStartToken(activityPushToStartToken: token)
      }
    }
  }

  private func observeLiveActivityUpdates() {
    guard #available(iOS 16.2, *) else { return }

    Task {
      for await activityUpdate in Activity<LiveActivityAttributes>.activityUpdates {
        let activityId = activityUpdate.id
        let activityState = activityUpdate.activityState

        print("Received activity update: \(activityId), \(activityState)")

        guard
          let activity = Activity<LiveActivityAttributes>.activities.first(where: {
            $0.id == activityId
          })
        else { return print("Didn't find activity with ID \(activityId)") }

        if case .active = activityState {
          Task {
            for await state in activity.activityStateUpdates {
              sendStateChange(activity: activity, activityState: state)
            }
          }

          if pushNotificationsEnabled {
            print("Adding push token observer for activity \(activity.id)")
            Task {
              for await pushToken in activity.pushTokenUpdates {
                let pushTokenString = pushToken.reduce("") { $0 + String(format: "%02x", $1) }

                sendPushToken(activity: activity, activityPushToken: pushTokenString)
              }
            }
          }
        }
      }
    }
  }

  private var pushNotificationsEnabled: Bool {
    Bundle.main.object(forInfoDictionaryKey: "ExpoLiveActivity_EnablePushNotifications") as? Bool
      ?? false
  }

  private func provisioningSummary(for bundle: Bundle?) -> [String: Any] {
    guard let bundle else {
      return ["present": false]
    }

    let profileUrl = bundle.bundleURL.appendingPathComponent("embedded.mobileprovision")
    guard
      let data = try? Data(contentsOf: profileUrl),
      let raw = String(data: data, encoding: .isoLatin1),
      let plistStart = raw.range(of: "<?xml"),
      let plistEnd = raw.range(of: "</plist>")
    else {
      return [
        "present": false,
        "bundleIdentifier": bundle.bundleIdentifier ?? "",
      ]
    }

    let plistString = String(raw[plistStart.lowerBound..<plistEnd.upperBound])
    let plistData = Data(plistString.utf8)
    let plist = (try? PropertyListSerialization.propertyList(
      from: plistData,
      options: [],
      format: nil
    )) as? [String: Any]
    let entitlements = plist?["Entitlements"] as? [String: Any]

    return [
      "present": true,
      "bundleIdentifier": bundle.bundleIdentifier ?? "",
      "applicationIdentifier": entitlements?["application-identifier"] as? String ?? "",
      "teamIdentifier": entitlements?["com.apple.developer.team-identifier"] as? String ?? "",
      "profileName": plist?["Name"] as? String ?? "",
      "profileAppIdName": plist?["AppIDName"] as? String ?? "",
    ]
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoLiveActivity")

    OnCreate {
      if pushNotificationsEnabled {
        observePushToStartToken()
      }
      observeLiveActivityUpdates()
    }

    Events("onTokenReceived", "onPushToStartTokenReceived", "onStateChange")

    Function("startActivity") {
      (state: LiveActivityState, maybeConfig: LiveActivityConfig?) -> String in
      guard #available(iOS 16.2, *) else { throw UnsupportedOSException("16.2") }

      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw LiveActivitiesNotEnabledException()
      }

      do {
        let config = maybeConfig ?? LiveActivityConfig()

        let attributes = LiveActivityAttributes(
          name: "ExpoLiveActivity",
          backgroundColor: config.backgroundColor,
          titleColor: config.titleColor,
          subtitleColor: config.subtitleColor,
          progressViewTint: config.progressViewTint,
          progressViewLabelColor: config.progressViewLabelColor,
          deepLinkUrl: config.deepLinkUrl,
          timerType: config.timerType == .digital ? .digital : .circular,
          padding: config.padding,
          paddingDetails: config.paddingDetails.map {
            LiveActivityAttributes.PaddingDetails(
              top: $0.top,
              bottom: $0.bottom,
              left: $0.left,
              right: $0.right,
              vertical: $0.vertical,
              horizontal: $0.horizontal
            )
          },
          imagePosition: config.imagePosition,
          imageWidth: config.imageWidth,
          imageHeight: config.imageHeight,
          imageWidthPercent: config.imageWidthPercent,
          imageHeightPercent: config.imageHeightPercent,
          imageAlign: config.imageAlign,
          contentFit: config.contentFit
        )

        let initialState = makeContentState(from: state)

        let activity = try Activity.request(
          attributes: attributes,
          content: .init(state: initialState, staleDate: nil),
          pushType: pushNotificationsEnabled ? .token : nil
        )

        Task {
          var newState = activity.content.state
          do {
            try await updateImages(state: state, newState: &newState)
            await activity.update(ActivityContent(state: newState, staleDate: nil))
          } catch {
            print("[ExpoLiveActivity] Post-start image update failed: \(error)")
          }
        }

        return activity.id
      } catch {
        throw UnexpectedErrorException(error)
      }
    }

    Function("getActivityDebugInfo") { () -> [String: Any] in
      guard #available(iOS 16.2, *) else {
        return [
          "available": false,
          "minimumOS": "16.2",
        ]
      }

      let activities = Activity<LiveActivityAttributes>.activities
      let pluginInfo = Bundle.main.builtInPlugInsURL
        .flatMap { try? FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil) }
        .flatMap { urls in
          urls.first { $0.lastPathComponent == "LiveActivity.appex" }
        }
        .flatMap { Bundle(url: $0) }
      let hostBundleIdentifier = Bundle.main.bundleIdentifier ?? ""
      let extensionBundleIdentifier = pluginInfo?.bundleIdentifier ?? ""
      let expectedExtensionBundleIdentifier = hostBundleIdentifier.isEmpty
        ? ""
        : "\(hostBundleIdentifier).LiveActivity"

      return [
        "available": true,
        "activitiesEnabled": ActivityAuthorizationInfo().areActivitiesEnabled,
        "hostBundleIdentifier": hostBundleIdentifier,
        "extensionBundleIdentifier": extensionBundleIdentifier,
        "expectedExtensionBundleIdentifier": expectedExtensionBundleIdentifier,
        "extensionMatchesHost": extensionBundleIdentifier == expectedExtensionBundleIdentifier,
        "extensionPath": pluginInfo?.bundleURL.lastPathComponent ?? "",
        "extensionPointIdentifier": (
          pluginInfo?.object(forInfoDictionaryKey: "NSExtension") as? [String: Any]
        )?["NSExtensionPointIdentifier"] as? String ?? "",
        "hostProvisioning": provisioningSummary(for: Bundle.main),
        "extensionProvisioning": provisioningSummary(for: pluginInfo),
        "activityCount": activities.count,
        "activities": activities.map { activity in
          [
            "id": activity.id,
            "state": String(describing: activity.activityState),
            "title": activity.content.state.title,
          ]
        },
      ]
    }

    Function("stopActivity") { (activityId: String, state: LiveActivityState) in
      guard #available(iOS 16.2, *) else { throw UnsupportedOSException("16.2") }

      guard
        let activity = Activity<LiveActivityAttributes>.activities.first(where: {
          $0.id == activityId
        })
      else { throw ActivityNotFoundException(activityId) }

      Task {
        print("Stopping activity with id: \(activityId)")
        var newState = makeContentState(from: state)
        do {
          try await updateImages(state: state, newState: &newState)
        } catch {
          print("[ExpoLiveActivity] Stop image update failed: \(error)")
        }
        await activity.end(
          ActivityContent(state: newState, staleDate: nil),
          dismissalPolicy: .immediate
        )
      }
    }

    Function("updateActivity") { (activityId: String, state: LiveActivityState) in
      guard #available(iOS 16.2, *) else {
        throw UnsupportedOSException("16.2")
      }

      guard
        let activity = Activity<LiveActivityAttributes>.activities.first(where: {
          $0.id == activityId
        })
      else { throw ActivityNotFoundException(activityId) }

      Task {
        print("Updating activity with id: \(activityId)")
        var newState = makeContentState(from: state)
        do {
          try await updateImages(state: state, newState: &newState)
          await activity.update(ActivityContent(state: newState, staleDate: nil))
        } catch {
          print("[ExpoLiveActivity] Update failed for \(activityId): \(error)")
        }
      }
    }
  }
}
