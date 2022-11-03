import { strict as assert } from "assert";

import * as Discord from "discord.js";

import { RequestInfo, RequestInit, Response } from 'node-fetch';
const fetch = (url: RequestInfo, init?: RequestInit) =>
  import("node-fetch").then(({ default: fetch }) => fetch(url, init));

import { async_exec_file, critical_error, M } from "../utils";
import { ApplicationCommandTypeMessage, is_authorized_admin, MINUTE } from "../common";
import { make_message_deletable } from "./deletable";
import { ContextMenuCommandBuilder, MessageFlags } from "discord.js";
import { GuildCommandManager } from "../infra/guild_command_manager";

let client: Discord.Client;

const color = 0x7E78FE; //0xA931FF;

const clang_format_path = "/usr/bin/clang-format";

const max_attachment_size = 1024 * 10;

// highlight js accepts all
const languages = new Set(["c", "h", "cpp", "hpp", "cc", "hh", "cxx", "cxx", "c++", "h++"]);

const languages_re = new RegExp([...languages]
    .sort((a, b) => b.length - a.length)
    .map(x => x.replaceAll("+", "\\+"))
    .join("|")
);

const code_begin = [
    "//",
    "/\\*",

    "#\\w+",

    "class",
    "struct",
    "typedef",
    "static",
    "inline",
    "template",
    "using namespace",

    "switch\\s*\\(",
    "if\\s*\\(",
    "for\\s*\\(",
    "while\\s*\\(",
    "do\\s*\\{",
    "main\\s*\\(",
    "main\\s*\\(",

    "char",
    "int",
    "unsigned",
    "long",
];

const code_begin_re = new RegExp(code_begin.join("|"));

const code_block_re = new RegExp(`\`\`\`(?:${languages_re.source}\b)?(.*?)\`\`\``, "gims");

const ignore_prefixes = [";compile", ";asm"];

async function clang_format(text: string, args: string[]) {
    const {stdout, stderr} = await async_exec_file(clang_format_path, args, {}, text);
    if(stderr.toString("utf8").trim().length != 0) {
        M.debug("Clang format stderr", stderr.toString("utf8"));
    }
    return stdout.toString("utf8");
}

const clang_format_style = [
    "BasedOnStyle: Chromium",
    "IndentWidth: 2",
    "SpacesInAngles: false",
    "SpaceAfterTemplateKeyword: false"
];

const clang_format_style_embed = [
    ...clang_format_style,
    "ColumnLimit: 48",
    "AlignAfterOpenBracket: AlwaysBreak"
];

export async function clang_format_embed_code(text: string) {
    return await clang_format(text, [`-style={${clang_format_style_embed.join(", ")}}`]);
}

export async function clang_format_general(text: string) {
    return await clang_format(text, [`-style={${clang_format_style.join(", ")}}`]);
}

// https://stackoverflow.com/questions/12568097/how-can-i-replace-a-string-by-range
function replace_range(s: string, start: number, end: number, substitute: string) {
    return s.substring(0, start) + substitute + s.substring(end);
}

async function format(replying_to: Discord.Message) {
    let content = replying_to.content;
    // does the message have code blocks?
    const code_blocks: string[] = [];
    content = content.replaceAll(code_block_re, (_, block) => {
        code_blocks.push(block);
        return `<[<[<[<[${code_blocks.length - 1}]>]>]>]>`;
    });
    // else ...
    if(code_blocks.length == 0) {
        const start = content.search(code_begin_re);
        if(start > -1) {
            const end = Math.max(...[...";}"].map(c => content.lastIndexOf(c)));
            if(end > start) {
                code_blocks.push(content.substring(start, end + 1));
                content = replace_range(content, start, end + 1, `<[<[<[<[${code_blocks.length - 1}]>]>]>]>`);
            }
        }
    }

    for(const [i, block] of code_blocks.entries()) {
        content = content.replace(`<[<[<[<[${i}]>]>]>]>`, `\`\`\`cpp\n${
            await clang_format_general(block)
        }\n\`\`\``);
    }

    // does the message have attachments?
    const attachments = await Promise.all([...replying_to.attachments.values()]
        .filter(attachment => attachment.contentType?.startsWith("text/") ?? false)
        .filter(attachment => attachment.size < max_attachment_size)
        .slice(0, 2) // at most 2 attachments
        .map(async (attachment) => {
            const fetch_response = await fetch(attachment.url);
            if(fetch_response.ok) {
                const text = await fetch_response.text();
                return new Discord.AttachmentBuilder(
                    await clang_format_general(text),
                    {
                        name: `${attachment}.cpp`
                    }
                );
            } else {
                return null;
            }
        })
    );

    return {content, attachments, found_code_blocks: code_blocks.length > 0};
}

function should_replace_original(replying_to: Discord.Message, request_timestamp: Date) {
    return request_timestamp.getTime() - replying_to.createdAt.getTime() < 30 * MINUTE
        && replying_to.id != replying_to.channel.id // Don't delete if it's a forum thread starter message
        && !replying_to.flags.has(MessageFlags.HasThread)
        && replying_to.attachments.size <= 2 // Also don't delete if it has additional/non-txt attachments
        && !replying_to.attachments.some(({contentType}) => contentType?.startsWith("text/") ?? false)
            // and not a ;compile, ;asm, or other bot command
        && !ignore_prefixes.some(prefix => replying_to.content.startsWith(prefix));
}

// TODO: More refactoring needed

async function on_message(message: Discord.Message) {
    try {
        if(message.author.bot) return; // Ignore bots
        if(message.content == "!f") {
            if(message.type == Discord.MessageType.Reply) {
                const replying_to = await message.fetchReference();

                M.debug("!f", [message.author.tag, message.author.id], replying_to.url);

                if(replying_to.author.bot) {
                    const reply = await message.reply("Can't format a bot message");
                    make_message_deletable(message, reply);
                    return;
                }

                const {content, attachments, found_code_blocks} = await format(replying_to);

                if(attachments.length || found_code_blocks) {
                    const embed = new Discord.EmbedBuilder()
                        .setColor(color)
                        .setAuthor({
                            name: replying_to.member?.displayName ?? replying_to.author.tag,
                            iconURL: replying_to.author.displayAvatarURL()
                        });
                    if(message.author.id != replying_to.author.id) {
                        embed.setFooter({
                            text: `Formatted by ${message.member?.displayName ?? message.author.tag}`,
                            iconURL: message.author.displayAvatarURL()
                        });
                    }
                    const formatted_message = await message.channel.send({
                        embeds: [embed],
                        content,
                        files: attachments.filter(x => x != null) as Discord.AttachmentBuilder[]
                    });
                    if(should_replace_original(replying_to, message.createdAt)) {
                        await replying_to.delete();
                    } else {
                        make_message_deletable(message, formatted_message);
                    }
                } else {
                    const reply = await message.reply("Nothing to format");
                    make_message_deletable(message, reply);
                }
            } else {
                const reply = await message.reply("!f must be used while replying to a message");
                make_message_deletable(message, reply);
            }
        }
    } catch(e) {
        critical_error(e);
        try {
            message.reply("Internal error while running !f");
        } catch(e) {
            critical_error(e);
        }
    }
}

async function on_interaction_create(interaction: Discord.Interaction) {
    try {
        if(interaction.isMessageContextMenuCommand() && interaction.commandName == "format") {
            const replying_to = interaction.targetMessage;

            M.debug("received format interaction", [interaction.user.tag, interaction.user.id], replying_to.url);

            if(replying_to.author.bot) {
                await interaction.reply({
                    content: "Can't format a bot message",
                    ephemeral: true
                });
                return;
            }

            // Out of caution
            // It might already be the case users can't use context menu commands on messages in channels they don't
            // have permissions for
            const channel = await interaction.guild!.channels.fetch(interaction.channelId);
            const member = await interaction.guild!.members.fetch(interaction.user.id);
            assert(channel);
            if(!channel.permissionsFor(member).has(Discord.PermissionsBitField.Flags.SendMessages)) {
                await interaction.reply({
                    content: "You don't have permissions here.",
                    ephemeral: true
                });
                return;
            }

            const {content, attachments, found_code_blocks} = await format(replying_to);

            if(attachments.length || found_code_blocks) {
                let embeds: Discord.EmbedBuilder[] | undefined;
                if(interaction.user.id != replying_to.author.id) {
                    embeds = [
                        new Discord.EmbedBuilder()
                            .setColor(color)
                            .setAuthor({
                                name: replying_to.member?.displayName ?? replying_to.author.tag,
                                iconURL: replying_to.author.displayAvatarURL()
                            })
                    ];
                }
                await interaction.reply({
                    embeds,
                    content,
                    files: attachments.filter(x => x != null) as Discord.AttachmentBuilder[]
                });
                if(should_replace_original(replying_to, interaction.createdAt)) {
                    await replying_to.delete();
                }
            } else {
                await interaction.reply({
                    content: "Nothing to format",
                    ephemeral: true
                });
            }
        }
    } catch(e) {
        critical_error(e);
    }
}

async function on_ready() {
    try {
        client.on("messageCreate", on_message);
        client.on("interactionCreate", on_interaction_create);
    } catch(e) {
        critical_error(e);
    }
}

export async function setup_format(_client: Discord.Client, guild_command_manager: GuildCommandManager) {
    try {
        client = _client;
        const format = new ContextMenuCommandBuilder()
            .setName("format")
            .setType(ApplicationCommandTypeMessage);
        guild_command_manager.register(format);
        client.on("ready", on_ready);
    } catch(e) {
        critical_error(e);
    }
}