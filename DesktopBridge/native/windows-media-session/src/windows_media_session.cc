#include <napi.h>

#include "worker_lifecycle.h"

#include <atomic>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>

#include <windows.h>

#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.Control.h>
#include <winrt/base.h>

namespace wmc = winrt::Windows::Media::Control;
namespace wf = winrt::Windows::Foundation;

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
  std::string deviceId;
  std::string sessionId;
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
  obj.Set("activeDeviceId", snapshot.deviceId);
  obj.Set("playbackSessionId", snapshot.sessionId);
  obj.Set("capturedAtMs", static_cast<double>(snapshot.capturedAtMs));
  obj.Set("positionBasisMs", static_cast<double>(snapshot.positionBasisMs));
  return obj;
}

bool SameSession(wmc::GlobalSystemMediaTransportControlsSession const& left,
                 wmc::GlobalSystemMediaTransportControlsSession const& right) {
  if (!left || !right) return !left && !right;
  return left.as<::IUnknown>().get() == right.as<::IUnknown>().get();
}

void SnapshotCallback(Napi::Env env, Napi::Function callback, void*, SnapshotData* data) {
  std::unique_ptr<SnapshotData> snapshot(data);
  if (env && !callback.IsEmpty()) callback.Call({SnapshotToJs(env, *snapshot)});
}

void ErrorCallback(Napi::Env env, Napi::Function callback, void*, std::string* data) {
  std::unique_ptr<std::string> message(data);
  if (env && !callback.IsEmpty()) callback.Call({Napi::String::New(env, *message)});
}

void CommandCallback(Napi::Env env, Napi::Function callback, void*, std::string* data) {
  std::unique_ptr<std::string> error(data);
  if (env && !callback.IsEmpty()) {
    if (error->empty()) callback.Call({env.Null()});
    else callback.Call({Napi::Error::New(env, *error).Value()});
  }
}

using SnapshotFunction = Napi::TypedThreadSafeFunction<void, SnapshotData, SnapshotCallback>;
using ErrorFunction = Napi::TypedThreadSafeFunction<void, std::string, ErrorCallback>;
using CommandFunction = Napi::TypedThreadSafeFunction<void, std::string, CommandCallback>;

struct CommandRequest {
  std::string action;
  std::string sessionId;
  std::string title;
  std::string artist;
  int64_t positionMs;
  int64_t expiresAtMs;
  CallbackOwner<CommandFunction> complete;
};

void CompleteCommand(std::unique_ptr<CommandRequest> request, const std::string& error) {
  request->complete.Send(error);
}

}  // namespace

class WindowsMediaSessionWatcher : public Napi::ObjectWrap<WindowsMediaSessionWatcher> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func =
        DefineClass(env,
                    "WindowsMediaSessionWatcher",
                    {InstanceMethod("start", &WindowsMediaSessionWatcher::Start),
                     InstanceMethod("stop", &WindowsMediaSessionWatcher::Stop),
                     InstanceMethod("executeCommand", &WindowsMediaSessionWatcher::ExecuteCommand)});

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

    snapshotTsfn_.Reset(SnapshotFunction::New(
        env, info[0].As<Napi::Function>(), "WindowsMediaSessionSnapshotCallback", 0, 1, nullptr));
    errorTsfn_.Reset(ErrorFunction::New(
        env, info[1].As<Napi::Function>(), "WindowsMediaSessionErrorCallback", 0, 1, nullptr));
  }

  ~WindowsMediaSessionWatcher() override { StopWorker(); }

 private:
  struct EventGate {
    std::mutex mutex;
    WindowsMediaSessionWatcher* watcher = nullptr;
  };

  auto SnapshotEvent(bool forceMediaRefresh, bool timelineUpdated) {
    return [gate = eventGate_, forceMediaRefresh, timelineUpdated](auto const&, auto const&) {
      std::lock_guard<std::mutex> lock(gate->mutex);
      if (gate->watcher) gate->watcher->ScheduleSnapshot(forceMediaRefresh, timelineUpdated);
    };
  }

  void Start(const Napi::CallbackInfo&) {
    if (running_.load()) {
      return;
    }
    StopWorker();
    if (!snapshotTsfn_ || !errorTsfn_) return;
    eventGate_ = std::make_shared<EventGate>();
    eventGate_->watcher = this;
    running_.store(true);
    worker_ = std::thread([this]() { RunWorkerLoop(); });
  }

  void Stop(const Napi::CallbackInfo&) { StopWorker(); }

  void ExecuteCommand(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() != 7 || !info[0].IsString() || !info[1].IsString() ||
        !info[2].IsString() || !info[3].IsString() || !info[4].IsNumber() ||
        !info[5].IsNumber() || !info[6].IsFunction()) {
      Napi::TypeError::New(env, "Invalid scoped playback command").ThrowAsJavaScriptException();
      return;
    }
    const auto action = info[0].As<Napi::String>().Utf8Value();
    if (action != "play" && action != "pause" && action != "next" &&
        action != "previous" && action != "seek" && action != "resync") {
      Napi::TypeError::New(env, "Unsupported scoped playback action").ThrowAsJavaScriptException();
      return;
    }
    const double position = info[4].As<Napi::Number>().DoubleValue();
    const double expires = info[5].As<Napi::Number>().DoubleValue();
    if (!(position >= 0 && position <= 86400000 && expires > 0 && expires <= 9007199254740991.0)) {
      Napi::RangeError::New(env, "Invalid playback command bounds").ThrowAsJavaScriptException();
      return;
    }
    std::lock_guard<std::mutex> lock(workerMutex_);
    if (!running_.load() || pendingCommand_) {
      Napi::Error::New(env, "Windows playback watcher is unavailable").ThrowAsJavaScriptException();
      return;
    }
    pendingCommand_ = std::make_unique<CommandRequest>(CommandRequest{
        action, info[1].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value(),
        info[3].As<Napi::String>().Utf8Value(), static_cast<int64_t>(position),
        static_cast<int64_t>(expires),
        CallbackOwner(CommandFunction::New(
            env, info[6].As<Napi::Function>(), "WindowsScopedPlayback", 0, 1, nullptr))});
    workerCv_.notify_one();
  }

  std::unique_ptr<CommandRequest> TakeCommand() {
    std::lock_guard<std::mutex> lock(workerMutex_);
    return std::move(pendingCommand_);
  }

  struct PlaybackOutcomeUnknown : std::runtime_error {
    PlaybackOutcomeUnknown() : std::runtime_error("Windows playback outcome unknown; the command was not retried.") {}
  };

  template <typename T>
  T AwaitOperation(wf::IAsyncOperation<T> const& operation, bool dispatched = false) {
    using namespace std::chrono_literals;
    const auto deadline = std::chrono::steady_clock::now() + (dispatched ? 3s : 2s);
    // A WinRT operation allows a single waiter. Poll status instead of
    // repeatedly calling wait_for, and wake promptly when the worker stops.
    auto status = operation.Status();
    while (status == wf::AsyncStatus::Started) {
      {
        std::unique_lock<std::mutex> lock(workerMutex_);
        if (running_.load() && std::chrono::steady_clock::now() < deadline) {
          workerCv_.wait_until(lock, (std::min)(deadline, std::chrono::steady_clock::now() + 25ms),
                               [this]() { return !running_.load(); });
        }
      }
      status = operation.Status();
      if (status == wf::AsyncStatus::Started &&
          (!running_.load() || std::chrono::steady_clock::now() >= deadline)) {
        try { operation.Cancel(); } catch (...) {}
        if (dispatched) throw PlaybackOutcomeUnknown();
        throw std::runtime_error("Windows playback observation timed out or stopped.");
      }
    }
    if (dispatched && status == wf::AsyncStatus::Canceled) throw PlaybackOutcomeUnknown();
    return operation.GetResults();
  }

  void DispatchCommand(CommandRequest const& request) {
    WireActiveSession();
    const auto session = activeSession_;
    if (!session || request.sessionId != sessionId_) {
      throw std::runtime_error("Windows playback session changed before dispatch.");
    }
    const auto assertCurrent = [&]() {
      if (!running_.load() || NowEpochMs() >= request.expiresAtMs) {
        throw std::runtime_error("Playback intent expired before dispatch.");
      }
      if (!SameSession(session, PickSession(manager_))) {
        throw std::runtime_error("Windows playback session changed before dispatch.");
      }
    };
    const auto media = AwaitOperation(session.TryGetMediaPropertiesAsync());
    if (HstringToUtf8(media.Title()) != request.title ||
        HstringToUtf8(media.Artist()) != request.artist) {
      throw std::runtime_error("Windows playback track changed before dispatch.");
    }
    const auto playback = session.GetPlaybackInfo();
    const auto controls = playback.Controls();
    const auto& action = request.action;
    const bool playing = playback.PlaybackStatus() == wmc::GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
    if ((action == "play" && playing) || ((action == "pause" || action == "resync") && !playing)) return;
    assertCurrent();
    bool accepted = false;
    if (action == "seek" && controls.IsPlaybackPositionEnabled()) {
      accepted = AwaitOperation(session.TryChangePlaybackPositionAsync(request.positionMs * 10000), true);
    } else if (action == "next" && controls.IsNextEnabled()) {
      accepted = AwaitOperation(session.TrySkipNextAsync(), true);
    } else if (action == "previous" && controls.IsPreviousEnabled()) {
      accepted = AwaitOperation(session.TrySkipPreviousAsync(), true);
    } else if (action == "play" && controls.IsPlayEnabled()) {
      accepted = AwaitOperation(session.TryPlayAsync(), true);
    } else if ((action == "pause" || action == "resync") && controls.IsPauseEnabled()) {
      accepted = AwaitOperation(session.TryPauseAsync(), true);
      if (action == "resync" && accepted) {
        {
          std::unique_lock<std::mutex> lock(workerMutex_);
          workerCv_.wait_for(lock, std::chrono::milliseconds(80), [this]() { return !running_.load(); });
        }
        // Finish a resync that already paused, using the same live session.
        if (!running_.load() || !SameSession(session, PickSession(manager_))) throw PlaybackOutcomeUnknown();
        try {
          const auto currentMedia = AwaitOperation(session.TryGetMediaPropertiesAsync());
          if (HstringToUtf8(currentMedia.Title()) != request.title ||
              HstringToUtf8(currentMedia.Artist()) != request.artist ||
              !running_.load() || !SameSession(session, PickSession(manager_))) {
            throw PlaybackOutcomeUnknown();
          }
        } catch (...) {
          throw PlaybackOutcomeUnknown();
        }
        accepted = session.GetPlaybackInfo().Controls().IsPlayEnabled() &&
            AwaitOperation(session.TryPlayAsync(), true);
      }
    }
    if (!accepted) throw std::runtime_error("Windows playback session rejected the command.");
  }

  void ProcessCommand() {
    auto request = TakeCommand();
    if (!request) return;
    std::string error;
    try {
      DispatchCommand(*request);
    } catch (const PlaybackOutcomeUnknown& failure) {
      error = failure.what();
      UnwireActiveSession();
      snapshotRequested_.store(true);
    } catch (const winrt::hresult_error& failure) {
      error = winrt::to_string(failure.message());
    } catch (const std::exception& failure) {
      error = failure.what();
    } catch (...) {
      error = "Windows playback command failed.";
    }
    CompleteCommand(std::move(request), error);
  }

  void StopWorker() {
    running_.store(false);
    if (eventGate_) {
      std::lock_guard<std::mutex> lock(eventGate_->mutex);
      eventGate_->watcher = nullptr;
    }
    {
      std::lock_guard<std::mutex> lock(workerMutex_);
      workerCv_.notify_all();
    }
    if (worker_.joinable()) {
      worker_.join();
    }
    if (auto request = TakeCommand()) {
      CompleteCommand(std::move(request), "Windows playback watcher stopped.");
    }
  }

  void ScheduleSnapshot(bool forceMediaRefresh, bool timelineUpdated) {
    if (!running_.load()) {
      return;
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
    struct Cleanup {
      WindowsMediaSessionWatcher& watcher;
      bool apartmentInitialized = false;
      ~Cleanup() { watcher.FinishWorker(apartmentInitialized); }
    } cleanup{*this};

    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      cleanup.apartmentInitialized = true;
      manager_ = AwaitOperation(wmc::GlobalSystemMediaTransportControlsSessionManager::RequestAsync());
      managerSessionsToken_ = manager_.SessionsChanged(SnapshotEvent(false, false));
    } catch (...) {
      if (running_.load()) ReportWorkerError("Unable to initialize media session watcher: ", std::current_exception());
      return;
    }

    // The first read is subject to the same timeout and retry policy as every
    // later read. A slow media-properties request does not kill the watcher.
    RunRecoveringPolls(
        [this]() { return running_.load(); },
        [this]() { PollOnce(); },
        [this](std::exception_ptr error) { ReportWorkerError("Snapshot update: ", error); },
        [this]() { ProcessCommand(); },
        [this]() {
          std::unique_lock<std::mutex> lock(workerMutex_);
          workerCv_.wait_for(lock, std::chrono::milliseconds(kFallbackPollIntervalMs), [this]() {
            return !running_.load() || snapshotRequested_.load() || pendingCommand_;
          });
          snapshotRequested_.store(false);
        });
  }

  void ReportWorkerError(const char* prefix, std::exception_ptr error) {
    try {
      std::rethrow_exception(error);
    } catch (const winrt::hresult_error& failure) {
      EmitError(std::string(prefix) + winrt::to_string(failure.message()));
    } catch (const std::exception& failure) {
      EmitError(std::string(prefix) + failure.what());
    } catch (...) {
      EmitError(std::string(prefix) + "unknown native error");
    }
  }

  void FinishWorker(bool apartmentInitialized) {
    {
      std::lock_guard<std::mutex> lock(workerMutex_);
      running_.store(false);
    }
    {
      std::lock_guard<std::mutex> lock(eventGate_->mutex);
      eventGate_->watcher = nullptr;
    }
    UnwireAll();
    manager_ = nullptr;
    cachedTitle_.clear();
    if (auto request = TakeCommand()) {
      CompleteCommand(std::move(request), "Windows playback watcher stopped.");
    }
    if (apartmentInitialized) winrt::uninit_apartment();
  }

  void UnwireActiveSession() {
    if (!activeSession_) return;
    RevokeEvent(sessionTimelineToken_, [this](auto token) { activeSession_.TimelinePropertiesChanged(token); });
    RevokeEvent(sessionPlaybackToken_, [this](auto token) { activeSession_.PlaybackInfoChanged(token); });
    RevokeEvent(sessionMediaToken_, [this](auto token) { activeSession_.MediaPropertiesChanged(token); });
    activeSession_ = nullptr;
    ResetEmittedSnapshot();
    ResetTimelineAnchor();
  }

  void UnwireAll() {
    UnwireActiveSession();
    RevokeEvent(managerSessionsToken_, [this](auto token) { manager_.SessionsChanged(token); });
  }

  void WireActiveSession() {
    if (!manager_) {
      return;
    }

    wmc::GlobalSystemMediaTransportControlsSession session = PickSession(manager_);
    if (SameSession(activeSession_, session)) return;
    const bool hadSession = !!activeSession_;
    UnwireActiveSession();
    sessionId_.clear();
    cachedTitle_.clear();
    lastPositionMs_ = -1;
    if (!session) {
      if (hadSession) {
        SnapshotData idle;
        idle.capturedAtMs = CaptureWallClockMs();
        EmitSnapshot(idle);
      }
      return;
    }

    static std::atomic<uint64_t> nextSessionId{0};
    sessionId_ = std::to_string(GetCurrentProcessId()) + ":" +
        std::to_string(NowEpochMs()) + ":" + std::to_string(++nextSessionId);
    activeSession_ = session;
    try {
      sessionTimelineToken_ = activeSession_.TimelinePropertiesChanged(SnapshotEvent(false, true));
      sessionPlaybackToken_ = activeSession_.PlaybackInfoChanged(SnapshotEvent(false, false));
      sessionMediaToken_ = activeSession_.MediaPropertiesChanged(SnapshotEvent(true, false));
    } catch (...) {
      UnwireActiveSession();
      throw;
    }
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

    WireActiveSession();
    const auto session = activeSession_;
    if (!session) {
      return;
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
        try {
          auto media = AwaitOperation(session.TryGetMediaPropertiesAsync());
          cachedTitle_ = HstringToUtf8(media.Title());
          cachedArtist_ = HstringToUtf8(media.Artist());
          cachedAlbum_ = HstringToUtf8(media.AlbumTitle());
        } catch (...) {
          forceMediaRefresh_.store(true);
          throw;
        }
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
    snapshot.deviceId = HstringToUtf8(session.SourceAppUserModelId());
    snapshot.sessionId = sessionId_;
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
    snapshotTsfn_.Send(snapshot);
    if (!snapshotTsfn_) running_.store(false);
  }

  void EmitError(const std::string& message) {
    errorTsfn_.Send(message);
    if (!errorTsfn_) running_.store(false);
  }

  CallbackOwner<SnapshotFunction> snapshotTsfn_;
  CallbackOwner<ErrorFunction> errorTsfn_;
  std::shared_ptr<EventGate> eventGate_;
  std::atomic<bool> running_{false};
  std::thread worker_;

  std::mutex workerMutex_;
  std::condition_variable workerCv_;
  std::unique_ptr<CommandRequest> pendingCommand_;
  std::atomic<bool> snapshotRequested_{false};
  std::atomic<bool> forceMediaRefresh_{false};
  std::atomic<bool> timelineUpdatedRequested_{false};

  bool timelineAnchorValid_ = false;
  int64_t timelinePositionMs_ = 0;
  int64_t timelineCapturedAtMs_ = 0;

  wmc::GlobalSystemMediaTransportControlsSessionManager manager_{nullptr};
  wmc::GlobalSystemMediaTransportControlsSession activeSession_{nullptr};
  std::string sessionId_;
  std::optional<winrt::event_token> managerSessionsToken_{};
  std::optional<winrt::event_token> sessionTimelineToken_{};
  std::optional<winrt::event_token> sessionPlaybackToken_{};
  std::optional<winrt::event_token> sessionMediaToken_{};

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
