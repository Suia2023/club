module club::club {
    use std::ascii;
    use std::string::{utf8, String};
    use std::type_name;
    use std::vector;
    use sui::coin::{Self, Coin};
    use sui::event::emit;
    use sui::object::{Self, UID, new, ID};
    use sui::sui;
    use sui::table::{Self, Table};
    use sui::transfer::{share_object, public_transfer};
    use sui::tx_context::{Self, TxContext, sender};
    use sui::vec_set::{Self, VecSet, keys};

    // errors
    const ERR_NOT_AUTHORIZED: u64 = 1;
    const ERR_INVALID_CLUB_NAME: u64 = 2;
    const ERR_INVALID_CHANNEL_NAME: u64 = 3;
    const ERR_ADMIN_ALREADY_EXISTS: u64 = 4;
    const ERR_ADMIN_NOT_FOUND: u64 = 5;
    const ERR_CHANNEL_NOT_FOUND: u64 = 6;
    const ERR_INVALID_FEE: u64 = 7;

    // constants
    const VERSION: u64 = 0;
    const CREATE_CLUB_FEE: u64 = 1000000000;  // 1 SUI

    // data structures
    struct Global has key, store {
        id: UID,
        version: u64,
        admins: VecSet<address>,
        fee_receiver: address,
        clubs: Table<u64, ID>,
        clubs_type_indexer: Table<ascii::String, vector<ID>>,
        clubs_owner_indexer: Table<address, vector<ID>>,
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


    // queries
    public fun get_club_by_index(global: &Global, index: u64): ID {
        *table::borrow(&global.clubs, index)
    }

    public fun get_clubs_by_type<T>(global: &Global): vector<ID> {
        let type_name = type_name::into_string(type_name::get<T>());
        if(!table::contains(&global.clubs_type_indexer, type_name)) {
            vector::empty()
        } else {
            *table::borrow(&global.clubs_type_indexer, type_name)
        }
    }

    public fun get_clubs_by_owner(global: &Global, owner: address): vector<ID> {
        if(!table::contains(&global.clubs_owner_indexer, owner)) {
            vector::empty()
        } else {
            *table::borrow(&global.clubs_owner_indexer, owner)
        }
    }

    // ====== Functions ======
    fun init(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        let global = Global {
            id: new(ctx),
            version: VERSION,
            admins: vec_set::singleton(sender),
            fee_receiver: sender,
            clubs: table::new(ctx),
            clubs_type_indexer: table::new(ctx),
            clubs_owner_indexer: table::new(ctx),
        };
        share_object(global);
    }

    entry public fun create_club<T>(
        club_global: &mut Global,
        fee: Coin<sui::SUI>,
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
        assert!(coin::value(&fee) == CREATE_CLUB_FEE, ERR_INVALID_FEE);
        public_transfer(fee, club_global.fee_receiver);
        let default_channel_name_str = utf8(default_channel_name);
        let default_channel = Channel {
            name: default_channel_name_str,
            deleted: false,
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
        // update clubs type indexer
        if (!table::contains(&club_global.clubs_type_indexer, type_name)) {
            table::add(&mut club_global.clubs_type_indexer, type_name, vector::singleton(id));
        } else {
            let clubs = table::borrow_mut(&mut club_global.clubs_type_indexer, type_name);
            vector::push_back(clubs, id);
        };
        // update clubs owner indexer
        if (!table::contains(&club_global.clubs_owner_indexer, club.creator)) {
            table::add(&mut club_global.clubs_owner_indexer, club.creator, vector::singleton(id));
        } else {
            let clubs = table::borrow_mut(&mut club_global.clubs_owner_indexer, club.creator);
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
        assert!(channel_index < vector::length(&club.channels), ERR_CHANNEL_NOT_FOUND);
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
        assert!(channel_index < vector::length(&club.channels), ERR_CHANNEL_NOT_FOUND);
        let channel = vector::borrow_mut(&mut club.channels, channel_index);
        channel.name = utf8(name);
    }
}
