package app.kainos.talk.fake;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.StatusBarNotification;

import java.util.ArrayList;
import java.util.List;

/**
 * A fake SMS app for the end-to-end test. It runs in the test APK's own process and uid, so
 * the hub sees its notifications as coming from another app. It is written in Java against
 * platform APIs only: that process has neither the Kotlin runtime nor AndroidX.
 *
 * Commands arrive as explicit broadcasts: POST a MessagingStyle conversation with a reply
 * action, CANCEL it. When the hub fires the reply action, REPLY re-posts the conversation with
 * the reply added as the user's own message, as a messaging app shows a sent reply.
 */
public class FakeSenderReceiver extends BroadcastReceiver {
    public static final String ACTION_POST = "app.kainos.talk.fake.POST";
    public static final String ACTION_CANCEL = "app.kainos.talk.fake.CANCEL";
    public static final String ACTION_REPLY = "app.kainos.talk.fake.REPLY";
    public static final String EXTRA_SENDERS = "senders";
    public static final String EXTRA_TEXTS = "texts";
    public static final String EXTRA_TIMES = "times";
    public static final String REPLY_KEY = "fake_reply_text";
    public static final String SHORTCUT_ID = "fake-chat-1";
    public static final int NOTIFICATION_ID = 42;
    private static final String CHANNEL_ID = "fake_chat";

    @Override
    public void onReceive(Context context, Intent intent) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(
                new NotificationChannel(CHANNEL_ID, "Fake chat", NotificationManager.IMPORTANCE_DEFAULT));
        String action = intent.getAction();
        if (ACTION_POST.equals(action)) {
            post(context, manager, messagesFrom(intent));
        } else if (ACTION_REPLY.equals(action)) {
            Bundle results = RemoteInput.getResultsFromIntent(intent);
            CharSequence reply = results == null ? null : results.getCharSequence(REPLY_KEY);
            if (reply == null) return;
            List<Notification.MessagingStyle.Message> messages = currentMessages(manager);
            messages.add(new Notification.MessagingStyle.Message(reply, System.currentTimeMillis(), (Person) null));
            post(context, manager, messages);
        } else if (ACTION_CANCEL.equals(action)) {
            manager.cancel(NOTIFICATION_ID);
        }
    }

    private static List<Notification.MessagingStyle.Message> messagesFrom(Intent intent) {
        String[] senders = intent.getStringArrayExtra(EXTRA_SENDERS);
        String[] texts = intent.getStringArrayExtra(EXTRA_TEXTS);
        long[] times = intent.getLongArrayExtra(EXTRA_TIMES);
        List<Notification.MessagingStyle.Message> messages = new ArrayList<>();
        for (int i = 0; i < texts.length; i++) {
            Person sender = senders[i].isEmpty()
                    ? null
                    : new Person.Builder().setName(senders[i]).setKey("person:" + senders[i]).build();
            messages.add(new Notification.MessagingStyle.Message(texts[i], times[i], sender));
        }
        return messages;
    }

    private static List<Notification.MessagingStyle.Message> currentMessages(NotificationManager manager) {
        for (StatusBarNotification sbn : manager.getActiveNotifications()) {
            if (sbn.getId() != NOTIFICATION_ID) continue;
            Parcelable[] bundles = sbn.getNotification().extras.getParcelableArray(Notification.EXTRA_MESSAGES, Parcelable.class);
            List<Notification.MessagingStyle.Message> messages =
                    Notification.MessagingStyle.Message.getMessagesFromBundleArray(bundles);
            return new ArrayList<>(messages);
        }
        return new ArrayList<>();
    }

    private static void post(Context context, NotificationManager manager, List<Notification.MessagingStyle.Message> messages) {
        Person me = new Person.Builder().setName("Me").setKey("person:me").build();
        Notification.MessagingStyle style = new Notification.MessagingStyle(me)
                .setConversationTitle("Test chat")
                .setGroupConversation(false);
        for (Notification.MessagingStyle.Message message : messages) {
            style.addMessage(message);
        }
        PendingIntent replyIntent = PendingIntent.getBroadcast(
                context,
                1,
                new Intent(context, FakeSenderReceiver.class).setAction(ACTION_REPLY),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        Notification.Action reply = new Notification.Action.Builder(
                Icon.createWithResource(context, android.R.drawable.ic_menu_send), "Reply", replyIntent)
                .addRemoteInput(new RemoteInput.Builder(REPLY_KEY).setLabel("Reply").build())
                .setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY)
                .build();
        PendingIntent open = PendingIntent.getBroadcast(
                context,
                2,
                new Intent(context, FakeSenderReceiver.class).setAction("app.kainos.talk.fake.OPEN"),
                PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setStyle(style)
                .setShortcutId(SHORTCUT_ID)
                .setContentIntent(open)
                .addAction(reply)
                .setOnlyAlertOnce(true)
                .build();
        manager.notify(NOTIFICATION_ID, notification);
    }
}
