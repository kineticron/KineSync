#pragma once

#include <node_api.h>

#include <exception>
#include <memory>
#include <optional>
#include <utility>

// The watcher gives the worker exclusive access until join. Main-thread
// destruction, or completion of an untaken request, then owns the release.
template <typename Function>
class CallbackOwner {
 public:
  explicit CallbackOwner(Function callback = {}) : callback_(callback) {}
  CallbackOwner(const CallbackOwner&) = delete;
  CallbackOwner& operator=(const CallbackOwner&) = delete;
  CallbackOwner(CallbackOwner&& other) noexcept
      : callback_(std::exchange(other.callback_, Function{})) {}
  ~CallbackOwner() { Reset(); }

  void Reset(Function callback = {}) {
    const auto previous = std::exchange(callback_, callback);
    if (previous) previous.Release();
  }

  explicit operator bool() const { return callback_ != nullptr; }

  template <typename Payload>
  void Send(Payload const& value) {
    if (!callback_) return;
    auto payload = std::make_unique<Payload>(value);
    const auto status = callback_.NonBlockingCall(payload.get());
    if (status == napi_ok) payload.release();
    // Node-API has already retired this producer. Neither another send nor
    // Release is legal, and the unqueued payload is still ours to delete.
    if (status == napi_closing) callback_ = Function{};
  }

 private:
  Function callback_;
};

template <typename Token, typename Revoke>
void RevokeEvent(std::optional<Token>& token, Revoke revoke) {
  if (auto subscribed = std::exchange(token, std::nullopt)) {
    try { revoke(*subscribed); } catch (...) {
      // A disconnected session can fail revocation. Other handlers still need cleanup.
    }
  }
}

template <typename Running, typename Poll, typename Report, typename Process, typename Wait>
void RunRecoveringPolls(Running running, Poll poll, Report report, Process process, Wait wait) {
  while (running()) {
    try {
      poll();
    } catch (...) {
      if (running()) report(std::current_exception());
    }
    if (!running()) break;
    process();
    wait();
  }
}
