#include <napi.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>

#include <windows.h>

#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.Control.h>
#include <winrt/base.h>

namespace wmc = winrt::Windows::Media::Control;

namespace {

// Slow safety-net poll when GSMTC events are quiet (seek/track changes use events).
constexpr int kFallbackPollIntervalMs = 2000;
// GSMTC position often lags real playback; allow this much slack before treating a read as stale.
constexpr int kStalePositionSlackMs = 500;
// Emit during steady playback only on meaningful position jumps or a slow heartbeat.
constexpr int kSteadyPlaybackHeartbeatMs = 8000;
constexpr int kSeekEmitThresholdMs = 300;

int64_t NowEpochMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

// Wall clock aligned with QueryPerformanceCounter (recovered from original .node).
int64_t CaptureWallClockMs() {
  static std::once_flag initFlag;
  static int64_t qpcBase = 0;
  static int64_t wallBaseMs = 0;
  static int64_t qpcFrequency = 0;

  std::call_once(initFlag, []() {
    LARGE_INTEGER frequency{};
    LARGE_INTEGER counter{};
    QueryPerformanceFrequency(&frequency);
    QueryPerformanceCounter(&counter);
    qpcFrequency = frequency.QuadPart;
    qpcBase = counter.QuadPart;
    wallBaseMs = NowEpochMs();
  });

  LARGE_INTEGER counter{};
  QueryPerformanceCounter(&counter);
  const int64_t elapsedMs = ((counter.QuadPart - qpcBase) * 1000) / qpcFrequency;
  return wallBaseMs + elapsedMs;
}

std::string HstringToUtf8(winrt::hstring const& value) {
  if (value.empty()) {
    return {};
  }
  return winrt::to_string(value);
}

bool ContainsIgnoreCase(std::wstring const& haystack, std::wstring const& needle) {
  if (needle.empty() || haystack.size() < needle.size()) {
    return false;
  }
  for (size_t i = 0; i + needle.size() <= haystack.size(); ++i) {
    bool matched = true;
    for (size_t j = 0; j < needle.size(); ++j) {
      wchar_t a = haystack[i + j];
      wchar_t b = needle[j];
      if (a >= L'A' && a <= L'Z') {
        a += L'a' - L'A';
      }
      if (b >= L'A' && b <= L'Z') {
        b += L'a' - L'A';
      }
      if (a != b) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

int64_t TimeSpanToMs(winrt::Windows::Foundation::TimeSpan const& value) {
  const int64_t ticks = value.count();
  if (ticks <= 0) {
    return 0;
  }
  return ticks / 10000;
}

wmc::GlobalSystemMediaTransportControlsSession PickSession(
    wmc::GlobalSystemMediaTransportControlsSessionManager const& manager) {
  winrt::Windows::Foundation::Collections::IVectorView<wmc::GlobalSystemMediaTransportControlsSession>
      sessions = manager.GetSessions();
  const uint32_t count = sessions.Size();
  for (uint32_t i = 0; i < count; ++i) {
    wmc::GlobalSystemMediaTransportControlsSession session = sessions.GetAt(i);
    winrt::hstring appId = session.SourceAppUserModelId();
    if (appId.empty()) {
      continue;
    }
    std::wstring wide(appId.c_str());
    if (ContainsIgnoreCase(wide, L"spotify")) {
      return session;
    }
  }
  return manager.GetCurrentSession();
}

struct SnapshotData {
  std::string title;
  std::string artist;
  std::string album;
  int64_t durationMs = 0;
  int64_t positionMs = 0;
  int64_t rawPositionMs = 0;
  bool isPlaying = false;
  bool timelineSync = false;
  std::string source = "windows-media-session-native";
  int64_t capturedAtMs = 0;
  int64_t positionBasisMs = 0;
};

Napi::Object SnapshotToJs(Napi::Env env, const SnapshotData& snapshot) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("title", snapshot.title);
  obj.Set("artist", snapshot.artist);
  obj.Set("album", snapshot.album);
  obj.Set("durationMs", static_cast<double>(snapshot.durationMs));
  obj.Set("positionMs", static_cast<double>(snapshot.positionMs));
  obj.Set("rawPositionMs", static_cast<double>(snapshot.rawPositionMs));
  obj.Set("isPlaying", snapshot.isPlaying);
  obj.Set("timelineSync", snapshot.timelineSync);
  obj.Set("source", snapshot.source);
  obj.Set("capturedAtMs", static_cast<double>(snapshot.capturedAtMs));
  obj.Set("positionBasisMs", static_cast<double>(snapshot.positionBasisMs));
  return obj;
}

}  // namespace

class WindowsMediaSessionWatcher : public Napi::ObjectWrap<WindowsMediaSessionWatcher> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func =
        DefineClass(env,
                    "WindowsMediaSessionWatcher",
                    {InstanceMethod("start", &WindowsMediaSessionWatcher::Start),
                     InstanceMethod("stop", &WindowsMediaSessionWatcher::Stop)});

    exports.Set("WindowsMediaSessionWatcher", func);
    return exports;
  }

  WindowsMediaSessionWatcher(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<WindowsMediaSessionWatcher>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsFunction()) {
      Napi::TypeError::New(env, "Expected (onSnapshot, onError)")
          .ThrowAsJavaScriptException();
      return;
    }

    snapshotTsfn_ = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "WindowsMediaSessionSnapshotCallback", 0, 1);
    errorTsfn_ = Napi::ThreadSafeFunction::New(
        env, info[1].As<Napi::Function>(), "WindowsMediaSessionErrorCallback", 0, 1);
  }

  ~WindowsMediaSessionWatcher() override { StopWorker(); }

 private:
  void Start(const Napi::CallbackInfo&) {
    if (running_.exchange(true)) {
      return;
    }
    worker_ = std::thread([this]() { RunWorkerLoop(); });
  }

  void Stop(const Napi::CallbackInfo&) { StopWorker(); }

  void StopWorker() {
    running_.store(false);
    {
      std::lock_guard<std::mutex> lock(workerMutex_);
      workerCv_.notify_all();
    }
    if (worker_.joinable()) {
      worker_.join();
    }
  }

  void ScheduleSnapshot(bool rewireSession, bool forceMediaRefresh, bool timelineUpdated) {
    if (!running_.load()) {
      return;
    }
    if (rewireSession) {
      rewireSessionRequested_.store(true);
    }
    if (forceMediaRefresh) {
      forceMediaRefresh_.store(true);
    }
    if (timelineUpdated) {
      timelineUpdatedRequested_.store(true);
    }
    snapshotRequested_.store(true);
    {
      std::lock_guard<std::mutex> lock(workerMutex_);
      workerCv_.notify_one();
    }
  }

  void RunWorkerLoop() {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      manager_ =
          wmc::GlobalSystemMediaTransportControlsSessionManager::RequestAsync().get();
    } catch (const winrt::hresult_error& error) {
      EmitError("Unable to initialize media session manager: " +
                winrt::to_string(error.message()));
      running_.store(false);
      return;
    } catch (const std::exception& error) {
      EmitError(std::string("Unable to initialize media session manager: ") + error.what());
      running_.store(false);
      return;
    } catch (...) {
      EmitError("Unable to initialize media session manager");
      running_.store(false);
      return;
    }

    try {
      managerSessionsToken_ = manager_.SessionsChanged(
          [this](wmc::GlobalSystemMediaTransportControlsSessionManager const&,
                 wmc::SessionsChangedEventArgs const&) {
            ScheduleSnapshot(true, false, false);
          });
      WireActiveSession();
      PollOnce();
    } catch (const winrt::hresult_error& error) {
      EmitError(std::string("Unable to wire GSMTC events: ") +
                winrt::to_string(error.message()));
      running_.store(false);
      return;
    } catch (const std::exception& error) {
      EmitError(std::string("Unable to wire GSMTC events: ") + error.what());
      running_.store(false);
      return;
    } catch (...) {
      EmitError("Unable to wire GSMTC events");
      running_.store(false);
      return;
    }

    while (running_.load()) {
      {
        std::unique_lock<std::mutex> lock(workerMutex_);
        workerCv_.wait_for(lock,
                           std::chrono::milliseconds(kFallbackPollIntervalMs),
                           [this]() {
                             return !running_.load() || snapshotRequested_.load();
                           });
        snapshotRequested_.store(false);
        if (!running_.load()) {
          break;
        }
      }

      try {
        if (rewireSessionRequested_.exchange(false)) {
          WireActiveSession();
        }
        PollOnce();
      } catch (const winrt::hresult_error& error) {
        EmitError(std::string("Snapshot update: ") + winrt::to_string(error.message()));
      } catch (const std::exception& error) {
        EmitError(std::string("Snapshot update std::exception: ") + error.what());
      } catch (...) {
        EmitError("Snapshot update unknown native error");
      }
    }

    UnwireAll();
    manager_ = nullptr;
    cachedTitle_.clear();
  }

  void UnwireActiveSession() {
    if (!activeSession_) {
      return;
    }
    try {
      activeSession_.TimelinePropertiesChanged(sessionTimelineToken_);
      activeSession_.PlaybackInfoChanged(sessionPlaybackToken_);
      activeSession_.MediaPropertiesChanged(sessionMediaToken_);
    } catch (...) {
      // Session may already be gone.
    }
    activeSession_ = nullptr;
    ResetEmittedSnapshot();
    ResetTimelineAnchor();
  }

  void UnwireAll() {
    UnwireActiveSession();
    if (manager_) {
      try {
        manager_.SessionsChanged(managerSessionsToken_);
      } catch (...) {
        // Manager may already be gone.
      }
    }
  }

  void WireActiveSession() {
    UnwireActiveSession();
    if (!manager_) {
      return;
    }

    wmc::GlobalSystemMediaTransportControlsSession session = PickSession(manager_);
    if (!session) {
      return;
    }

    activeSession_ = session;
    sessionTimelineToken_ = activeSession_.TimelinePropertiesChanged(
        [this](wmc::GlobalSystemMediaTransportControlsSession const&,
               wmc::TimelinePropertiesChangedEventArgs const&) {
          ScheduleSnapshot(false, false, true);
        });
    sessionPlaybackToken_ = activeSession_.PlaybackInfoChanged(
        [this](wmc::GlobalSystemMediaTransportControlsSession const&,
               wmc::PlaybackInfoChangedEventArgs const&) {
          ScheduleSnapshot(false, false, false);
        });
    sessionMediaToken_ = activeSession_.MediaPropertiesChanged(
        [this](wmc::GlobalSystemMediaTransportControlsSession const&,
               wmc::MediaPropertiesChangedEventArgs const&) {
          ScheduleSnapshot(false, true, false);
        });
  }

  void ResetTimelineAnchor() {
    timelineAnchorValid_ = false;
    timelinePositionMs_ = 0;
    timelineCapturedAtMs_ = 0;
  }

  void SetTimelineAnchor(int64_t positionMs, int64_t capturedAtMs) {
    timelinePositionMs_ = positionMs;
    timelineCapturedAtMs_ = capturedAtMs;
    timelineAnchorValid_ = true;
  }

  int64_t ResolvePlaybackPositionMs(int64_t rawPositionMs,
                                    int64_t capturedAtMs,
                                    bool isPlaying,
                                    bool forceResync) {
    if (!timelineAnchorValid_ || forceResync) {
      SetTimelineAnchor(rawPositionMs, capturedAtMs);
      return rawPositionMs;
    }

    if (!isPlaying) {
      SetTimelineAnchor(rawPositionMs, capturedAtMs);
      return rawPositionMs;
    }

    const int64_t elapsed =
        std::max(int64_t(0), capturedAtMs - timelineCapturedAtMs_);
    const int64_t extrapolated = timelinePositionMs_ + elapsed;
    const int64_t delta = rawPositionMs - extrapolated;

    if (std::abs(delta) >= kSeekEmitThresholdMs) {
      SetTimelineAnchor(rawPositionMs, capturedAtMs);
      return rawPositionMs;
    }

    if (rawPositionMs < extrapolated - kStalePositionSlackMs) {
      return extrapolated;
    }

    if (delta > 50) {
      SetTimelineAnchor(rawPositionMs, capturedAtMs);
      return rawPositionMs;
    }

    return extrapolated;
  }

  void PollOnce() {
    if (!manager_) {
      return;
    }

    wmc::GlobalSystemMediaTransportControlsSession session =
        activeSession_ ? activeSession_ : PickSession(manager_);
    if (!session) {
      return;
    }

    if (!activeSession_) {
      WireActiveSession();
      session = activeSession_;
      if (!session) {
        return;
      }
    }

    auto timeline = session.GetTimelineProperties();
    auto playback = session.GetPlaybackInfo();
    const int64_t capturedAtMs = CaptureWallClockMs();

    const int64_t startMs = TimeSpanToMs(timeline.StartTime());
    const int64_t endMs = TimeSpanToMs(timeline.EndTime());
    const int64_t durationMs = endMs > startMs ? endMs - startMs : endMs;
    const int64_t rawPositionMs = TimeSpanToMs(timeline.Position());
    const bool timelineSync = timelineUpdatedRequested_.exchange(false);

    const auto status = playback.PlaybackStatus();
    const bool isPlaying =
        status == wmc::GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;

    std::string title;
    std::string artist;
    std::string album;

    {
      std::lock_guard<std::mutex> lock(mediaMutex_);
      const bool trackLikelyChanged =
          lastPositionMs_ >= 0 && rawPositionMs + 1500 < lastPositionMs_;
      const bool needsMediaRefresh = forceMediaRefresh_.exchange(false) ||
                                     cachedTitle_.empty() || trackLikelyChanged;

      if (needsMediaRefresh) {
        auto media = session.TryGetMediaPropertiesAsync().get();
        cachedTitle_ = HstringToUtf8(media.Title());
        cachedArtist_ = HstringToUtf8(media.Artist());
        cachedAlbum_ = HstringToUtf8(media.AlbumTitle());
      }

      lastPositionMs_ = rawPositionMs;
      title = cachedTitle_;
      artist = cachedArtist_;
      album = cachedAlbum_;
    }

    if (title.empty()) {
      return;
    }

    const bool titleChanged =
        lastEmitted_.initialized && title != lastEmitted_.title;
    const int64_t positionMs = ResolvePlaybackPositionMs(
        rawPositionMs, capturedAtMs, isPlaying, timelineSync || titleChanged);

    SnapshotData snapshot;
    snapshot.title = title;
    snapshot.artist = artist;
    snapshot.album = album;
    snapshot.durationMs = durationMs;
    snapshot.positionMs = positionMs;
    snapshot.rawPositionMs = rawPositionMs;
    snapshot.isPlaying = isPlaying;
    snapshot.timelineSync = timelineSync || titleChanged;
    snapshot.capturedAtMs = capturedAtMs;
    snapshot.positionBasisMs = timelineCapturedAtMs_;

    if (!ShouldEmitSnapshot(snapshot)) {
      return;
    }

    RecordEmittedSnapshot(snapshot);
    EmitSnapshot(snapshot);
  }

  bool ShouldEmitSnapshot(const SnapshotData& snapshot) {
    if (!lastEmitted_.initialized) {
      return true;
    }

    if (snapshot.title != lastEmitted_.title) {
      return true;
    }
    if (snapshot.isPlaying != lastEmitted_.isPlaying) {
      return true;
    }

    const int64_t posDelta = snapshot.positionMs - lastEmitted_.positionMs;
    const int64_t elapsedMs =
        std::max(int64_t(0), snapshot.capturedAtMs - lastEmitted_.emittedAtMs);

    if (std::abs(posDelta) >= kSeekEmitThresholdMs) {
      return true;
    }

    if (!snapshot.isPlaying) {
      if (posDelta != 0) {
        return true;
      }
      return elapsedMs >= 3000;
    }

    // Spotify often leaves timeline.Position stale between events. During steady
    // playback, reject reads that trail what we already emitted plus elapsed time.
    const int64_t expectedMinPosition =
        lastEmitted_.positionMs + elapsedMs - kStalePositionSlackMs;
    if (snapshot.positionMs < expectedMinPosition) {
      return false;
    }

    return elapsedMs >= kSteadyPlaybackHeartbeatMs;
  }

  void RecordEmittedSnapshot(const SnapshotData& snapshot) {
    lastEmitted_.initialized = true;
    lastEmitted_.title = snapshot.title;
    lastEmitted_.positionMs = snapshot.positionMs;
    lastEmitted_.isPlaying = snapshot.isPlaying;
    lastEmitted_.emittedAtMs = snapshot.capturedAtMs;
  }

  void ResetEmittedSnapshot() { lastEmitted_.initialized = false; }

  void EmitSnapshot(const SnapshotData& snapshot) {
    auto payload = new SnapshotData(snapshot);
    snapshotTsfn_.BlockingCall(
        payload,
        [](Napi::Env env, Napi::Function callback, SnapshotData* data) {
          callback.Call({SnapshotToJs(env, *data)});
          delete data;
        });
  }

  void EmitError(const std::string& message) {
    auto payload = new std::string(message);
    errorTsfn_.BlockingCall(
        payload,
        [](Napi::Env env, Napi::Function callback, std::string* data) {
          callback.Call({Napi::String::New(env, *data)});
          delete data;
        });
  }

  Napi::ThreadSafeFunction snapshotTsfn_;
  Napi::ThreadSafeFunction errorTsfn_;
  std::atomic<bool> running_{false};
  std::thread worker_;

  std::mutex workerMutex_;
  std::condition_variable workerCv_;
  std::atomic<bool> snapshotRequested_{false};
  std::atomic<bool> rewireSessionRequested_{false};
  std::atomic<bool> forceMediaRefresh_{false};
  std::atomic<bool> timelineUpdatedRequested_{false};

  bool timelineAnchorValid_ = false;
  int64_t timelinePositionMs_ = 0;
  int64_t timelineCapturedAtMs_ = 0;

  wmc::GlobalSystemMediaTransportControlsSessionManager manager_{nullptr};
  wmc::GlobalSystemMediaTransportControlsSession activeSession_{nullptr};
  winrt::event_token managerSessionsToken_{};
  winrt::event_token sessionTimelineToken_{};
  winrt::event_token sessionPlaybackToken_{};
  winrt::event_token sessionMediaToken_{};

  std::mutex mediaMutex_;
  std::string cachedTitle_;
  std::string cachedArtist_;
  std::string cachedAlbum_;
  int64_t lastPositionMs_ = -1;

  struct LastEmittedSnapshot {
    bool initialized = false;
    std::string title;
    int64_t positionMs = 0;
    bool isPlaying = false;
    int64_t emittedAtMs = 0;
  } lastEmitted_;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return WindowsMediaSessionWatcher::Init(env, exports);
}

NODE_API_MODULE(windows_media_session, InitAll)
