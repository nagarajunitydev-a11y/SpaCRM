/**
 * tutorialContent.js
 * Pure data for the Initial Setup Guide: one short guided tour per core
 * section (Staff, Services, Clients, Booking), plus a one-paragraph summary
 * of "what/why/how" for each section's ⓘ info icon.
 *
 * Every step's `target` is a selector for something that always exists in
 * that section's UI regardless of whether any data has been added yet (a
 * button, a search box, a list container) — never a specific record's own
 * card — so a brand-new, still-empty salon can complete the whole tour.
 */

export const TUTORIAL_ORDER = ['staff', 'services', 'customers', 'appointments'];

export const TUTORIALS = {
    staff: {
        id: 'staff',
        tab: 'staff',
        label: 'Staff',
        summary: {
            title: 'Staff',
            body: 'This is your team roster. Add every stylist, therapist or team member here with their name, role and phone number — once added, they can be assigned to appointments and have their daily attendance tracked.',
        },
        steps: [
            {
                target: '[data-tutorial="staff-add-button"]',
                title: 'Add your team',
                body: 'Tap "Add Staff" to register a stylist or team member — just their name, role/specialization, and phone number.',
            },
            {
                target: '[data-tutorial="staff-tabs"]',
                title: 'Team & Attendance',
                body: 'Switch between your Team roster and daily Attendance from here — mark staff Present, Absent, Late, Half Day or Leave for any date.',
            },
            {
                target: '[data-tutorial="staff-list"]',
                title: 'Your roster',
                body: 'Everyone you add appears here. You can edit their details or remove them at any time.',
            },
        ],
    },
    services: {
        id: 'services',
        tab: 'services',
        label: 'Services',
        summary: {
            title: 'Services',
            body: 'This is your service catalogue — the treatments and packages your salon offers, each with a price and duration. Services listed here are what you pick from when booking an appointment and billing a client.',
        },
        steps: [
            {
                target: '[data-tutorial="services-add-button"]',
                title: 'Add a service',
                body: 'Tap "Add Service" to add a treatment or package with its price and duration.',
            },
            {
                target: '[data-tutorial="services-catalogue-button"]',
                title: 'Or import ready-made ones',
                body: 'New here? Tap "Import From Catalogue" to add common salon services instantly instead of typing them all in — you can still edit, disable or delete any of them later.',
            },
            {
                target: '[data-tutorial="services-list"]',
                title: 'Your catalogue',
                body: 'Every service you add or import shows up here, ready to be picked when booking an appointment.',
            },
        ],
    },
    customers: {
        id: 'customers',
        tab: 'customers',
        label: 'Clients',
        summary: {
            title: 'Clients',
            body: 'This is your client list. Add your customers here with their phone, email and birthday — each client automatically gets a referral code and loyalty points, and you can set up a discount for them from the Payment window during billing.',
        },
        steps: [
            {
                target: '[data-tutorial="customers-add-button"]',
                title: 'Add a client',
                body: 'Tap "Add Client" to register a customer — their name, phone number and, optionally, email and date of birth.',
            },
            {
                target: '[data-tutorial="customers-search"]',
                title: 'Find a client fast',
                body: 'Search by name, phone or email to quickly find any client once your list starts growing.',
            },
            {
                target: '[data-tutorial="customers-list"]',
                title: 'Your client list',
                body: 'Tap any client card to open their profile — referral code, wallet balance, and full history.',
            },
        ],
    },
    appointments: {
        id: 'appointments',
        tab: 'appointments',
        label: 'Booking Appointment',
        summary: {
            title: 'Booking Appointment',
            body: 'This is where you book and manage appointments. Pick a client, one or more services and a stylist, then track status from Confirmed through to Completed — and collect payment right from an appointment once the service is done.',
        },
        steps: [
            {
                target: '[data-tutorial="appointments-book-button"]',
                title: 'Book an appointment',
                body: 'Tap "Book" to schedule a client for one or more services with a chosen stylist, date and time.',
            },
            {
                target: '[data-tutorial="appointments-filters"]',
                title: 'Filter your bookings',
                body: 'Once you have bookings, filter them by status, staff, service or payment state, or search directly.',
            },
            {
                target: '[data-tutorial="appointments-list"]',
                title: 'Manage & bill',
                body: 'Every booking appears here. Update its status as work progresses, and collect payment — including any client discount — once the service is complete.',
            },
        ],
    },
};

export default { TUTORIAL_ORDER, TUTORIALS };
