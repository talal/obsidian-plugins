use dprint_plugin_markdown::configuration::ConfigurationBuilder;
use dprint_plugin_markdown::format_text;

fn main() {
    let global_config = dprint_core::configuration::GlobalConfiguration {
        indent_width: Some(4),
        line_width: Some(100),
        ..Default::default()
    };
    let mut config = ConfigurationBuilder::new();
    config.global_config(global_config);
    let config = config.build();

    let res1 = format_text("~~~\0`-?", &config, |_, _, _| Ok(None))
        .unwrap()
        .unwrap();
    let res2 = format_text(&res1, &config, |_, _, _| Ok(None))
        .unwrap()
        .unwrap_or(res1.clone());
    let res3 = format_text(&res2, &config, |_, _, _| Ok(None))
        .unwrap()
        .unwrap_or(res2.clone());
    println!("res1: {:?}", res1);
    println!("res2: {:?}", res2);
    println!("res3: {:?}", res3);
}
