module club::club {
    use std::ascii;
    use std::string::{utf8, String};
    use std::type_name;
    use std::vector;
    use sui::clock::{Clock, timestamp_ms};
    use sui::event::emit;
    use sui::object::{Self, UID, new, ID};
    use sui::table::{Self, Table};
    use sui::table_vec::{Self, TableVec};
    use sui::transfer::share_object;
    use sui::tx_context::{Self, TxContext, sender};
    use sui::vec_set::{Self, VecSet, keys};

    // errors
    const ERR_NOT_AUTHORIZED: u64 = 1;
    const ERR_MESSAGE_NOT_FOUND: u64 = 2;
    const ERR_MESSAGE_DELETED: u64 = 3;
    const ERR_INVALID_CLUB_NAME: u64 = 4;
    const ERR_INVALID_CHANNEL_NAME: u64 = 5;
    const ERR_ADMIN_ALREADY_EXISTS: u64 = 6;
    const ERR_ADMIN_NOT_FOUND: u64 = 7;
    const ERROR_CHANNEL_NOT_FOUND: u64 = 8;

    // constants
    const VERSION: u64 = 0;

    // data structures
    struct Global has key, store {
        id: UID,
        version: u64,
        admins: VecSet<address>,
        clubs: Table<u64, ID>,
        clubs_type_indexer: Table<ascii::String, vector<ID>>,
    }

    struct Club has key, store {
        id: UID,
        index: u64,
        creator: address,
        admins: VecSet<address>,
        name: String,
        logo: String,
        description: String,
        announcement: String,
        type_name: ascii::String,
        threshold: u64,
        channels: vector<Channel>,
    }

    struct Channel has store {
        name: String,
        deleted: bool,
        messages: TableVec<Message>,
    }

    struct Message has copy, drop, store {
        sender: address,
        content: vector<u8>,
        timestamp: u64,
        deleted: bool,
    }

    // ====== Events ======
    struct ClubCreated has copy, drop {
        index: u64,
        id: ID,
        creator: address,
        admins: vector<address>,
        name: String,
        logo: String,
        description: String,
        announcement: String,
        type_name: ascii::String,
        threshold: u64,
        channels: vector<String>,
    }

    // ====== Functions ======
    fun init(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        let global = Global {
            id: new(ctx),
            version: VERSION,
            admins: vec_set::singleton(sender),
            clubs: table::new(ctx),
            clubs_type_indexer: table::new(ctx),
        };
        share_object(global);
    }

    entry public fun create_club<T>(
        club_global: &mut Global,
        name: vector<u8>,
        logo: vector<u8>,
        description: vector<u8>,
        announcement: vector<u8>,
        threshold: u64,
        default_channel_name: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(vector::length(&name) > 0, ERR_INVALID_CLUB_NAME);
        assert!(vector::length(&default_channel_name) > 0, ERR_INVALID_CHANNEL_NAME);
        let default_channel_name_str = utf8(default_channel_name);
        let default_channel = Channel {
            name: default_channel_name_str,
            deleted: false,
            messages: table_vec::empty(ctx),
        };
        let index = table::length(&club_global.clubs);
        let type_name = type_name::into_string(type_name::get<T>());
        let club = Club {
            id: object::new(ctx),
            index,
            creator: tx_context::sender(ctx),
            admins: vec_set::empty(),
            name: utf8(name),
            logo: utf8(logo),
            description: utf8(description),
            announcement: utf8(announcement),
            type_name: type_name::into_string(type_name::get<T>()),
            threshold,
            channels: vector::singleton(default_channel),
        };
        let id = object::id(&club);
        table::add(&mut club_global.clubs, index, id);
        if (!table::contains(&club_global.clubs_type_indexer, type_name)) {
            table::add(&mut club_global.clubs_type_indexer, type_name, vector::singleton(id));
        } else {
            let clubs = table::borrow_mut(&mut club_global.clubs_type_indexer, type_name);
            vector::push_back(clubs, id);
        };
        emit(ClubCreated {
            index,
            id,
            creator: club.creator,
            admins: *keys(&club.admins),
            name: club.name,
            logo: club.logo,
            description: club.description,
            announcement: club.announcement,
            type_name: club.type_name,
            threshold: club.threshold,
            channels: vector::singleton(default_channel_name_str),
        });
        share_object(club);
    }

    entry public fun add_club_admin(
        _global: &Global,
        club: &mut Club,
        admin: address,
        ctx: &mut TxContext,
    ) {
        assert!(sender(ctx) == club.creator, ERR_NOT_AUTHORIZED);
        assert!(!vec_set::contains(&club.admins, &admin), ERR_ADMIN_ALREADY_EXISTS);
        vec_set::insert(&mut club.admins, admin);
    }

    entry public fun remove_club_admin(
        _global: &Global,
        club: &mut Club,
        admin: address,
        ctx: &mut TxContext,
    ) {
        assert!(sender(ctx) == club.creator, ERR_NOT_AUTHORIZED);
        assert!(vec_set::contains(&club.admins, &admin), ERR_ADMIN_NOT_FOUND);
        vec_set::remove(&mut club.admins, &admin);
    }

    fun is_authorized_to_update_club_info(club: &Club, sender: address): bool {
        sender == club.creator || vec_set::contains(&club.admins, &sender)
    }

    entry public fun update_club_name(
        _global: &Global,
        club: &mut Club,
        name: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(is_authorized_to_update_club_info(club, tx_context::sender(ctx)), ERR_NOT_AUTHORIZED);
        club.name = utf8(name);
    }

    entry public fun update_club_logo(
        _global: &Global,
        club: &mut Club,
        logo: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(is_authorized_to_update_club_info(club, tx_context::sender(ctx)), ERR_NOT_AUTHORIZED);
        club.logo = utf8(logo);
    }

    entry public fun update_club_description(
        _global: &Global,
        club: &mut Club,
        description: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(is_authorized_to_update_club_info(club, tx_context::sender(ctx)), ERR_NOT_AUTHORIZED);
        club.description = utf8(description);
    }

    entry public fun update_club_announcement(
        _global: &Global,
        club: &mut Club,
        announcement: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(is_authorized_to_update_club_info(club, tx_context::sender(ctx)), ERR_NOT_AUTHORIZED);
        club.announcement = utf8(announcement);
    }

    entry public fun update_club_threshold(
        _global: &Global,
        club: &mut Club,
        threshold: u64,
        ctx: &mut TxContext,
    ) {
        assert!(is_authorized_to_update_club_info(club, tx_context::sender(ctx)), ERR_NOT_AUTHORIZED);
        club.threshold = threshold;
    }

    entry public fun add_club_channel(
        _global: &Global,
        club: &mut Club,
        name: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(is_authorized_to_update_club_info(club, tx_context::sender(ctx)), ERR_NOT_AUTHORIZED);
        let channel = Channel {
            name: utf8(name),
            deleted: false,
            messages: table_vec::empty(ctx),
        };
        vector::push_back(&mut club.channels, channel);
    }

    entry public fun delete_club_channel(
        _global: &Global,
        club: &mut Club,
        channel_index: u64,
        ctx: &mut TxContext,
    ) {
        assert!(is_authorized_to_update_club_info(club, tx_context::sender(ctx)), ERR_NOT_AUTHORIZED);
        assert!(channel_index < vector::length(&club.channels), ERROR_CHANNEL_NOT_FOUND);
        let channel = vector::borrow_mut(&mut club.channels, channel_index);
        channel.deleted = true;
    }

    entry public fun update_club_channel_name(
        _global: &Global,
        club: &mut Club,
        channel_index: u64,
        name: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(is_authorized_to_update_club_info(club, tx_context::sender(ctx)), ERR_NOT_AUTHORIZED);
        assert!(channel_index < vector::length(&club.channels), ERROR_CHANNEL_NOT_FOUND);
        let channel = vector::borrow_mut(&mut club.channels, channel_index);
        channel.name = utf8(name);
    }

    entry public fun new_message(
        clock: &Clock,
        _club_global: &Global,
        club: &mut Club,
        channel_index: u64,
        content: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(channel_index < vector::length(&club.channels), ERROR_CHANNEL_NOT_FOUND);
        let channel = vector::borrow_mut(&mut club.channels, channel_index);
        let sender = tx_context::sender(ctx);
        let message = Message {
            sender,
            content,
            timestamp: timestamp_ms(clock),
            deleted: false,
        };
        table_vec::push_back(&mut channel.messages, message);
    }

    entry public fun delete_message(
        _club_global: &Global,
        club: &mut Club,
        channel_index: u64,
        message_index: u64,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(channel_index < vector::length(&club.channels), ERROR_CHANNEL_NOT_FOUND);
        let channel = vector::borrow_mut(&mut club.channels, channel_index);
        assert!(message_index < table_vec::length(&channel.messages), ERR_MESSAGE_NOT_FOUND);
        let message = table_vec::borrow_mut(&mut channel.messages, message_index);
        assert!(message.sender == sender, ERR_NOT_AUTHORIZED);
        assert!(!message.deleted, ERR_MESSAGE_DELETED);
        message.content = vector::empty();
        message.deleted = true;
    }
}
