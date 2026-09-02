/**
 * predefinedServices.js
 * Default salon service catalogue offered to every salon. Purely reference
 * data — importing an entry copies it into that salon's own `services`
 * collection (via servicesRepository.addService), it is never referenced
 * live. Existing salon services are never touched or overwritten by it.
 */

export const PREDEFINED_SERVICES = [
    { name: 'Precision Haircut', category: 'Hair', duration: '45m', price: 75 },
    { name: 'Blow Dry & Style', category: 'Hair', duration: '30m', price: 45 },
    { name: 'Balayage & Gloss', category: 'Hair', duration: '120m', price: 160 },
    { name: 'Root Touch-Up Colour', category: 'Hair', duration: '90m', price: 110 },
    { name: 'Keratin Smoothing Treatment', category: 'Hair', duration: '150m', price: 220 },
    { name: 'Signature Facial', category: 'Skin', duration: '60m', price: 95 },
    { name: 'Deep Cleanse Facial', category: 'Skin', duration: '45m', price: 70 },
    { name: 'Classic Manicure', category: 'Nails', duration: '30m', price: 30 },
    { name: 'Classic Pedicure', category: 'Nails', duration: '45m', price: 40 },
    { name: 'Gel Manicure', category: 'Nails', duration: '45m', price: 50 },
    { name: 'Full Body Massage', category: 'Spa', duration: '60m', price: 100 },
    { name: 'Head & Shoulder Massage', category: 'Spa', duration: '30m', price: 45 },
    { name: 'Threading (Eyebrows)', category: 'Grooming', duration: '10m', price: 12 },
    { name: 'Waxing (Full Arms)', category: 'Grooming', duration: '30m', price: 35 },
    { name: 'Bridal Makeup', category: 'Makeup', duration: '90m', price: 250 },
];

export default PREDEFINED_SERVICES;
