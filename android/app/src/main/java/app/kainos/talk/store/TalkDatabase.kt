package app.kainos.talk.store

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [ConversationEntity::class, MessageEntity::class, MailEntity::class],
    version = 1,
    exportSchema = true,
)
abstract class TalkDatabase : RoomDatabase() {
    abstract fun dao(): TalkDao

    companion object {
        /** App-private storage; excluded from backup and device transfer by the manifest rules. */
        fun open(context: Context): TalkDatabase =
            Room.databaseBuilder(context, TalkDatabase::class.java, "talk.db").build()
    }
}
