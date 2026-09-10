#include "opentui.h"
#include <stddef.h>
#include <stdio.h>

#define LAYOUT(T) sizeof(T), _Alignof(T)
#define FIELD(T, F) offsetof(T, F)
#define RECORD(T) LAYOUT(T), FIELD(T, struct_size), FIELD(T, abi_version)

/* This helper supplies only compiler layout facts, never rendering operations. */
int main(void) {
    static const uint32_t values[] = {
#include "constants.generated.h"
        LAYOUT(ot_status),
        LAYOUT(ot_handle), FIELD(ot_handle, context_id), FIELD(ot_handle, slot), FIELD(ot_handle, generation),
        LAYOUT(ot_output_ticket), FIELD(ot_output_ticket, session), FIELD(ot_output_ticket, request_id),
        FIELD(ot_output_ticket, byte_count), FIELD(ot_output_ticket, reserved),
        RECORD(ot_scene_frame_request), FIELD(ot_scene_frame_request, session),
        FIELD(ot_scene_frame_request, root), FIELD(ot_scene_frame_request, node),
        FIELD(ot_scene_frame_request, frame_id), FIELD(ot_scene_frame_request, request_id),
        FIELD(ot_scene_frame_request, layout_epoch), FIELD(ot_scene_frame_request, hook_generation),
        FIELD(ot_scene_frame_request, kind), FIELD(ot_scene_frame_request, num),
        FIELD(ot_scene_frame_request, width), FIELD(ot_scene_frame_request, height), FIELD(ot_scene_frame_request, reserved),
        RECORD(ot_context_options), FIELD(ot_context_options, flags), FIELD(ot_context_options, object_capacity),
        FIELD(ot_context_options, render_cells_max), FIELD(ot_context_options, reserved),
        RECORD(ot_context_error), FIELD(ot_context_error, status), FIELD(ot_context_error, reserved),
        RECORD(ot_session_options), FIELD(ot_session_options, chunk_size), FIELD(ot_session_options, span_capacity),
        FIELD(ot_session_options, max_bytes), FIELD(ot_session_options, control_capacity), FIELD(ot_session_options, reserved),
        RECORD(ot_session_renderer_env_options), FIELD(ot_session_renderer_env_options, width),
        FIELD(ot_session_renderer_env_options, height), FIELD(ot_session_renderer_env_options, remote_mode),
        FIELD(ot_session_renderer_env_options, entry_count), FIELD(ot_session_renderer_env_options, byte_count),
        FIELD(ot_session_renderer_env_options, reserved),
        RECORD(ot_session_renderer_state), FIELD(ot_session_renderer_state, width), FIELD(ot_session_renderer_state, height),
        FIELD(ot_session_renderer_state, frame_count), FIELD(ot_session_renderer_state, frame_pending),
        FIELD(ot_session_renderer_state, reserved),
        RECORD(ot_session_terminal_options), FIELD(ot_session_terminal_options, flags),
        FIELD(ot_session_terminal_options, kitty_keyboard_flags),
        RECORD(ot_session_pump_result), FIELD(ot_session_pump_result, status),
        FIELD(ot_session_pump_result, reserved), FIELD(ot_session_pump_result, deadline_ns),
        RECORD(ot_styled_text_chunk), FIELD(ot_styled_text_chunk, byte_count),
        FIELD(ot_styled_text_chunk, flags), FIELD(ot_styled_text_chunk, foreground),
        FIELD(ot_styled_text_chunk, background), FIELD(ot_styled_text_chunk, attributes),
        FIELD(ot_styled_text_chunk, reserved), FIELD(ot_styled_text_chunk, link_offset),
        FIELD(ot_styled_text_chunk, link_byte_count),
        RECORD(ot_scene_paint_options), FIELD(ot_scene_paint_options, z_index),
        FIELD(ot_scene_paint_options, opacity), FIELD(ot_scene_paint_options, translate_x),
        FIELD(ot_scene_paint_options, translate_y), FIELD(ot_scene_paint_options, border_sides),
        FIELD(ot_scene_paint_options, should_fill), FIELD(ot_scene_paint_options, background),
        FIELD(ot_scene_paint_options, border_color), FIELD(ot_scene_paint_options, border_style),
        FIELD(ot_scene_paint_options, focusable), FIELD(ot_scene_paint_options, focused_border_color),
        FIELD(ot_scene_paint_options, reserved),
    };
    for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); ++i) {
        if (printf("%u\n", values[i]) < 0) return 1;
    }
    return fflush(stdout) == 0 ? 0 : 1;
}
