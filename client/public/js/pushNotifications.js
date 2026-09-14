import { api } from "./api.js";

// Push requires https/localhost, service worker support, and the Push API
// itself -- iOS Safari only has all three from iOS 16.4+ and, critically,
// only for a PWA actually added to the home screen (not the in-browser
// tab), so this degrades to "unsupported" there rather than throwing.
export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window;
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function getPushSubscriptionState() {
  if (!pushSupported()) return { supported: false, subscribed: false };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return { supported: true, subscribed: Boolean(subscription) };
}

export async function enablePushNotifications() {
  // Notification.requestPermission() MUST be the first await here, called
  // directly off the toggle's click handler with nothing else awaited
  // first. iOS Safari (including a standalone home-screen PWA) only shows
  // the permission prompt while the click's transient user-activation is
  // still live; an earlier await (the VAPID key fetch used to run first)
  // burns that activation on a network round-trip, so by the time this
  // call finally runs, WebKit just silently declines to prompt at all --
  // no dialog, no error, the toggle simply never turns on. Reported as
  // "I cannot turn on notifications" / "nothing happens" on an iPhone PWA.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted");

  const { enabled, key } = await api.getVapidPublicKey();
  if (!enabled || !key) throw new Error("Push notifications are not configured on the server");

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  await api.subscribePush(subscription.toJSON());
}

export async function disablePushNotifications() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api.unsubscribePush(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe();
}
