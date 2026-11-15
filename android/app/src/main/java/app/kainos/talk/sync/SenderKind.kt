package app.kainos.talk.sync

/** Who a conversation comes from, as the PC's Texts page sorts it: people on one side, notices on the other. */
enum class SenderKind(val wire: String) {
    PERSON("person"),
    SERVICE("service"),
}

/**
 * An automated sender (alphanumeric ID like "StripeLink", or a short code like 36679) is a
 * [SenderKind.SERVICE]; a saved contact, a group, a phone number or anything unclear is a person.
 * Not [PhoneNumbers.key]: that rejects anything under 7 digits, which is exactly what a short code is.
 */
fun senderKind(address: String, isContact: Boolean, isGroup: Boolean): SenderKind {
    if (isGroup || isContact) return SenderKind.PERSON
    val trimmed = address.trim()
    if (trimmed.any(Char::isLetter)) return SenderKind.SERVICE
    val compact = trimmed.filterNot { it == ' ' || it == '.' || it == '-' || it == '(' || it == ')' }
    if (compact.startsWith("+")) return SenderKind.PERSON
    return if (compact.length in 1..SHORT_CODE_MAX_DIGITS && compact.all { it in '0'..'9' }) SenderKind.SERVICE else SenderKind.PERSON
}

private const val SHORT_CODE_MAX_DIGITS = 6
